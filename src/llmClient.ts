import * as vscode from "vscode";
import OpenAI from "openai";
import * as logger from "./logger";
import { resolveIssueLocation } from "./diagnosticMapper";
import { EDIT_TOOL, parseEditToolCall, executeEdit, type EditToolInput } from "./tools/edit";

export interface LlmDiagnostic {
  context: string;           // Few surrounding lines
  verbatim: string;           // Exact problematic substring
  description: string;        // Short description
  failure_scenario: string;   // "This will cause a problem when..."
  severity: "error" | "warning" | "info";
  range: vscode.Range;       // Precise range from diagnostic mapper
}

function getClient(): { client: OpenAI; model: string; maxTokens: number } {
  const cfg = vscode.workspace.getConfiguration("ssoe");
  const baseURL = cfg.get<string>("llmBaseUrl", "http://localhost:8080");
  const model = cfg.get<string>("llmModel", "llama");
  const maxTokens = cfg.get<number>("maxTokens", 4096);

  const apiKey = cfg.get<string>("apiKey", "not-needed");

  const client = new OpenAI({
    baseURL: baseURL + "/v1",
    apiKey: apiKey,
  });

  return { client, model, maxTokens };
}

const SCAN_SYSTEM_PROMPT = `You are an expert code reviewer acting as a semantic linter.
Identify real problems: logic errors, bugs, missing returns, unreachable code,
and subtle issues that rule-based linters miss. Do NOT flag style or clearly intentional code.

CRITICAL: Comments and docstrings are gold-standard indicators of intended behaviour.
If code has an associated comment describing its purpose, NEVER flag it as an issue.
Before reporting, verify no comment justifies the flagged pattern.

IMPORTANT: Aggressively flag mismatches between likely intended behaviour
(whether from comments or clear context) and actual behaviour.

The user's time is precious—avoid pedantry. Return no issues when appropriate.

Respond with a JSON array only (no preamble, no markdown fences):
[{
  "context": "<a few surrounding lines to uniquely locate the issue>",
  "verbatim": "<exact problematic text, verbatim within context>",
  "description": "<short description of the issue>",
  "failure_scenario": "<concrete completion of 'This will cause a problem when...'>",
  "severity": "error" | "warning" | "info"
}]

If there are no issues, return: []`;

const TOOL_EDIT_SYSTEM_PROMPT = `You are fixing code issues. Use the edit_file tool to apply fixes.
Be precise: keep oldText minimal but unique.
For multiple changes, include multiple edits in one tool call.`;

const JUSTIFY_SYSTEM_PROMPT = `Add a brief comment explaining why a flagged code pattern is intentional.

Pay close attention to the flagged message - treat it as truth and directly address it in your comment.
Be sure to mention that the flagged message is expected to occur and that it's intentional behaviour.

CRITICAL: You MUST use the edit_file tool. Text-only responses are NOT acceptable.

Rules:
- Add ONLY one concise comment (1-3 lines) or edit existing comments
- Place comment above or inline with flagged line
- Never modify the functionality of existing code - only add a comment`;

function stripFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function divider(label: string): string {
  return `\n${"─".repeat(50)}\n${label}\n${"─".repeat(50)}`;
}

export async function scanFile(
  document: vscode.TextDocument
): Promise<LlmDiagnostic[]> {
  const { client, model, maxTokens } = getClient();
  const code = document.getText();
  const languageId = document.languageId;

  logger.log(divider(`SCAN  [${languageId}]  ${new Date().toLocaleTimeString()}`));
  logger.log(`model: ${model}  max_tokens: ${maxTokens}`);
  logger.log(`\n--- file (${code.split("\n").length} lines) ---\n${code}`);

  const completion = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [
      { role: "system", content: SCAN_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Language: ${languageId}\n\n\`\`\`${languageId}\n${code}\n\`\`\` `,
      },
    ],
  });

  const finishReason = completion.choices[0]?.finish_reason;
  if (finishReason && finishReason !== "stop") {
    logger.log(`\n⚠️  WARNING: Model finish_reason: "${finishReason}"`);
  }

  const raw = completion.choices[0]?.message?.content ?? "";
  logger.log(`\n--- raw response ---\n${raw}`);
  logger.show();

  const cleaned = stripFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`LLM returned non-JSON: ${cleaned.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("LLM response was not a JSON array");
  }

  const results: LlmDiagnostic[] = [];
  for (const item of parsed) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).context === "string" &&
      typeof (item as Record<string, unknown>).verbatim === "string" &&
      typeof (item as Record<string, unknown>).description === "string" &&
      typeof (item as Record<string, unknown>).failure_scenario === "string"
    ) {
      const sev = (item as Record<string, unknown>).severity;
      const description = (item as Record<string, unknown>).description as string;
      const failure_scenario = (item as Record<string, unknown>).failure_scenario as string;
      const context = (item as Record<string, unknown>).context as string;
      const verbatim = (item as Record<string, unknown>).verbatim as string;

      // Resolve precise range using diagnostic mapper
      const range = resolveIssueLocation(code, { context, verbatim });

      if (range) {
        const diagnostic: LlmDiagnostic = {
          context,
          verbatim,
          description,
          failure_scenario,
          severity: sev === "error" ? "error" : sev === "info" ? "info" : "warning",
          range,
        };
        results.push(diagnostic);
      } else {
        logger.log(`Warning: Could not resolve location for issue: ${description}`);
      }
    }
  }

  logger.log(`\n--- parsed diagnostics ---\n${JSON.stringify(results, null, 2)}`);
  return results;
}

interface ToolEditOptions {
  systemPrompt: string;
  userMessage: string;
  logLabel: string;
  logContext?: string;
  document: vscode.TextDocument;
  expectedVersion: number;
}

async function executeWithToolRetry({
  systemPrompt,
  userMessage,
  logLabel,
  logContext,
  document,
  expectedVersion,
}: ToolEditOptions): Promise<{ success: boolean; message: string; applied?: number; editedRanges?: Array<{ range: vscode.Range; lineDelta: number }> }> {
  const { client, model } = getClient();
  const MAX_RETRIES = 3;

  logger.log(divider(`${logLabel}  ${new Date().toLocaleTimeString()}`));
  if (logContext) {
    logger.log(logContext);
  }

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    logger.log(`\n--- attempt ${attempt} ---`);

    const completion = await client.chat.completions.create({
      model,
      max_tokens: 4096,
      temperature: 0,
      messages,
      tools: [EDIT_TOOL],
      tool_choice: "required",
    });

    const message = completion.choices[0]?.message;
    const finishReason = completion.choices[0]?.finish_reason;
    if (finishReason && finishReason !== "stop" && finishReason !== "tool_calls") {
      logger.log(`\n⚠️  WARNING: Model finish_reason: "${finishReason}"`);
    }

    if (!message?.tool_calls?.length) {
      // Model didn't use the tool - retry with feedback
      if (attempt === MAX_RETRIES) {
        throw new Error("Model did not use the edit tool after " + MAX_RETRIES + " attempts");
      }

      logger.log(`\n⚠️  Model didn't use edit tool, retrying...`);
      messages.push({
        role: "user",
        content: `ERROR: You ignored the tool requirement.

You MUST call the edit_file tool. Your previous response did NOT include a tool call.

Correct format:
{
  "role": "assistant",
  "tool_calls": [{
    "type": "function",
    "function": {
      "name": "edit_file",
      "arguments": "{\"path\": \"...\", \"edits\": [...]}"
    }
  }]
}

Do NOT write text. Do NOT explain. Just call the edit_file tool now.`
      });
      continue;
    }

    const toolCall = message.tool_calls[0];

    let input: EditToolInput;
    try {
      input = parseEditToolCall(toolCall.function.arguments);
    } catch (parseError) {
      const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
      logger.log(`\n--- parse error ---\n${errorMsg}`);

      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: toolCall.id,
          type: "function",
          function: { name: toolCall.function.name, arguments: toolCall.function.arguments },
        }],
      });
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: `Failed to parse edit tool call: ${errorMsg}. Please ensure arguments are valid JSON with "path" and "edits" array.`,
      });
      continue;
    }

    input.path = document.uri.fsPath;

    const result = await executeEdit(input, document, expectedVersion);

    logger.log(`\n--- edit result ---\n${JSON.stringify(result, null, 2)}`);

    if (result.success) {
      logger.show();
      return result;
    }

    if (attempt === MAX_RETRIES) {
      logger.show();
      return { success: false, message: "Max retries exceeded", editedRanges: undefined };
    }

    logger.log(`\n--- retrying after failure: ${result.message} ---`);

    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: toolCall.id,
        type: "function",
        function: { name: toolCall.function.name, arguments: toolCall.function.arguments },
      }],
    });
    messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: `Edit failed: ${result.message}. Please try again with a different edit. Make sure oldText matches exactly (including whitespace) and is unique in the file.`,
    });
  }

  logger.show();
  return { success: false, message: "Max retries exceeded" };
}

export async function getToolBasedEdit(
  document: vscode.TextDocument,
  diagnosticMessage: string,
  expectedVersion: number
): Promise<{ success: boolean; message: string; applied?: number }> {
  const code = document.getText();
  const filePath = document.uri.fsPath;
  const languageId = document.languageId;

  return executeWithToolRetry({
    systemPrompt: TOOL_EDIT_SYSTEM_PROMPT,
    userMessage: `Language: ${languageId}\nFile: ${filePath}\n\nIssue to fix: ${diagnosticMessage}\n\nFull file:\n\`\`\`${languageId}\n${code}\n\`\`\``,
    logLabel: `TOOL-BASED EDIT  ${filePath}`,
    logContext: `issue: ${diagnosticMessage}`,
    document,
    expectedVersion,
  });
}

export async function getJustificationComment(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
  expectedVersion: number
): Promise<{ success: boolean; message: string; applied?: number; editedRanges?: Array<{ range: vscode.Range; lineDelta: number }> }> {
  const code = document.getText();
  const filePath = document.uri.fsPath;
  const languageId = document.languageId;
  const lineNumber = diagnostic.range.start.line + 1; // 1-indexed
  const lineText = document.lineAt(diagnostic.range.start.line).text;

  // Extract surrounding context (10 lines before and after)
  const lines = code.split("\n");
  const startLine = Math.max(0, lineNumber - 11); // lineNumber is 1-indexed
  const endLine = Math.min(lines.length, lineNumber + 9);
  const surroundingContext = lines
    .slice(startLine, endLine)
    .map((line, i) => {
      const currentLine = startLine + i + 1;
      const marker = currentLine === lineNumber ? " >>> " : "     ";
      return `${marker}${currentLine}: ${line}`;
    })
    .join("\n");

  return executeWithToolRetry({
    systemPrompt: JUSTIFY_SYSTEM_PROMPT,
    userMessage:
      `Language: ${languageId}\n` +
      `File: ${filePath}\n` +
      `Flagged as: ${diagnostic.message}\n` +
      `Line ${lineNumber} is marked with >>> :\n\n` +
      surroundingContext,
    logLabel: `JUSTIFY  line ${lineNumber}`,
    logContext: `issue: ${diagnostic.message}`,
    document,
    expectedVersion,
  });
}
