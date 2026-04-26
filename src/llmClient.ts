import * as vscode from "vscode";
import OpenAI from "openai";
import * as logger from "./logger";
import { chunkFile } from "./astChunker";
import { EDIT_TOOL, parseEditToolCall, executeEdit, type EditToolInput } from "./tools/edit";

export interface LlmDiagnostic {
  line: number; // 1-indexed
  severity: "error" | "warning" | "info";
  message: string;
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
Analyze the code and identify real problems: logic errors, bugs, missing returns,
unreachable code, bad practices, and subtle issues that rule-based linters miss.
Do NOT flag style preferences or things that are clearly intentional.
Read docstrings and comments to determine whether suspected issues
have already been acknowledged or are accepted as intended behaviour
(do not report these).
The user's time is precious, so do not be overly pedantic.
It is often correct to return no issues, so do that when appropriate.

Return ONLY a valid JSON array. Each element must be:
{"line": <1-indexed integer>, "severity": "error"|"warning"|"info", "message": "<concise one-line description>"}

If there are no issues, return an empty array: []
No markdown fences, no prose, no explanation — just the raw JSON array.`;

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

  // Test chunking - log chunks at start of scan
  try {
    const chunkResult = await chunkFile(document);
    if (chunkResult) {
      logger.log("─── CHUNKING TEST ─────────────────────────");
      logger.log(`Module context (${chunkResult.moduleContext.split("\n").length} lines):`);
      logger.log(chunkResult.moduleContext || "(empty)");
      logger.log(`\nChunks found: ${chunkResult.chunks.length}`);
      chunkResult.chunks.forEach((chunk, i) => {
        logger.log(`\n[Chunk ${i + 1}] ${chunk.type}${chunk.name ? " " + chunk.name : ""} (lines ${chunk.range.start.line + 1}-${chunk.range.end.line + 1})`);
        logger.log(`Hash: ${chunk.hash}`);
        logger.log(chunk.text.slice(0, 200) + (chunk.text.length > 200 ? "..." : ""));
      });
      logger.log("─── END CHUNKING TEST ───────\n");
    } else {
      logger.log("─── CHUNKING TEST: chunkFile returned null ───\n");
    }
  } catch (chunkError) {
    logger.log(`─── CHUNKING TEST ERROR: ${chunkError} ───\n`);
  }

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
        content: `Language: ${languageId}\n\n\`\`\`${languageId}\n${code}\n\`\`\``,
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
      typeof (item as Record<string, unknown>).line === "number" &&
      typeof (item as Record<string, unknown>).message === "string"
    ) {
      const sev = (item as Record<string, unknown>).severity;
      results.push({
        line: (item as Record<string, unknown>).line as number,
        severity: sev === "error" ? "error" : sev === "info" ? "info" : "warning",
        message: (item as Record<string, unknown>).message as string,
      });
    }
  }

  logger.log(`\n--- parsed diagnostics ---\n${JSON.stringify(results, null, 2)}`);
  return results;
}

interface ToolEditOptions {
  systemPrompt: string;
  userMessage: string;
  filePath: string;
  logLabel: string;
  logContext?: string;
}

async function executeWithToolRetry({
  systemPrompt,
  userMessage,
  filePath,
  logLabel,
  logContext,
}: ToolEditOptions): Promise<{ success: boolean; message: string; applied?: number }> {
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
      throw new Error("Model did not use the edit tool");
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

    input.path = filePath;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const result = await executeEdit(input, workspaceRoot);

    logger.log(`\n--- edit result ---\n${JSON.stringify(result, null, 2)}`);

    if (result.success) {
      logger.show();
      return result;
    }

    if (attempt === MAX_RETRIES) {
      logger.show();
      return result;
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
  code: string,
  languageId: string,
  diagnosticMessage: string,
  filePath: string
): Promise<{ success: boolean; message: string; applied?: number }> {
  return executeWithToolRetry({
    systemPrompt:
      "You are fixing code issues. Use the edit_file tool to apply fixes. " +
      "Be precise: keep oldText minimal but unique. " +
      "For multiple changes, include multiple edits in one tool call.",
    userMessage: `Language: ${languageId}\nFile: ${filePath}\n\nIssue to fix: ${diagnosticMessage}\n\nFull file:\n\`\`\`${languageId}\n${code}\n\`\`\``,
    filePath,
    logLabel: `TOOL-BASED EDIT  ${filePath}`,
    logContext: `issue: ${diagnosticMessage}`,
  });
}

export async function getJustificationComment(
  code: string,
  lineNumber: number,
  lineText: string,
  diagnosticMessage: string,
  languageId: string,
  filePath: string
): Promise<{ success: boolean; message: string; applied?: number }> {
  return executeWithToolRetry({
    systemPrompt:
      "You are writing a concise code comment or concise documentation " +
      "in nearby location to justify an intentional code pattern. " +
      "Use the edit_file tool to provide your comment/documentation.",
    userMessage:
      `Language: ${languageId}\n` +
      `File: ${filePath}\n` +
      `Line ${lineNumber}: ${lineText}\n` +
      `Flagged as: ${diagnosticMessage}\n\n` +
      `Full file:\n` +
      `\`\`\`${languageId}\n` +
      `${code}\n` +
      `\`\`\``,
    filePath,
    logLabel: `JUSTIFY  line ${lineNumber}`,
    logContext: `issue: ${diagnosticMessage}`,
  });
}
