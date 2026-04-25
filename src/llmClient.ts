import * as vscode from "vscode";
import OpenAI from "openai";
import * as logger from "./logger";
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
  const maxTokens = cfg.get<number>("maxTokens", 2048);

  const client = new OpenAI({
    baseURL: baseURL + "/v1",
    apiKey: "not-needed",
  });

  return { client, model, maxTokens };
}

const SCAN_SYSTEM_PROMPT = `You are an expert code reviewer acting as a semantic linter.
Analyze the code and identify real problems: logic errors, bugs, missing returns,
unreachable code, bad practices, and subtle issues that rule-based linters miss.
Do NOT flag style preferences or things that are clearly intentional.

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
  code: string,
  languageId: string
): Promise<LlmDiagnostic[]> {
  const { client, model, maxTokens } = getClient();

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

export async function getToolBasedEdit(
  code: string,
  languageId: string,
  diagnosticMessage: string,
  filePath: string
): Promise<{ success: boolean; message: string; applied?: number }> {
  const { client, model } = getClient();

  logger.log(divider(`TOOL-BASED EDIT  ${filePath}  ${new Date().toLocaleTimeString()}`));
  logger.log(`issue: ${diagnosticMessage}`);

  const completion = await client.chat.completions.create({
    model,
    max_tokens: 4096,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are fixing code issues. Use the edit_file tool to apply fixes. " +
          "Be precise: keep oldText minimal but unique. " +
          "For multiple changes, include multiple edits in one tool call.",
      },
      {
        role: "user",
        content: `Language: ${languageId}
File: ${filePath}

Issue to fix: ${diagnosticMessage}

Full file:
\`\`\`${languageId}
${code}
\`\`\``,
      },
    ],
    tools: [EDIT_TOOL],
    tool_choice: "required", // Force tool use
  });

  const message = completion.choices[0]?.message;

  if (!message?.tool_calls?.length) {
    throw new Error("Model did not use the edit tool");
  }

  const toolCall = message.tool_calls[0];
  const input: EditToolInput = parseEditToolCall(toolCall.function.arguments);

  // Override path with the actual file path
  input.path = filePath;

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const result = await executeEdit(input, workspaceRoot);

  logger.log(`\n--- edit result ---\n${JSON.stringify(result, null, 2)}`);
  logger.show();

  return result;
}

export async function getJustificationComment(
  lineNumber: number,
  lineText: string,
  diagnosticMessage: string,
  languageId: string
): Promise<string> {
  const { client, model } = getClient();

  logger.log(divider(`JUSTIFY  line ${lineNumber}  ${new Date().toLocaleTimeString()}`));
  logger.log(`issue: ${diagnosticMessage}`);

  const commentChar = ["python", "ruby", "shellscript"].includes(languageId)
    ? "#"
    : "//";

  const completion = await client.chat.completions.create({
    model,
    max_tokens: 128,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          `You are writing a code comment to justify an intentional code pattern. ` +
          `Return ONLY the comment line starting with "${commentChar}". No explanation, no extra text.`,
      },
      {
        role: "user",
        content:
          `Language: ${languageId}\n` +
          `Line ${lineNumber}: ${lineText}\n` +
          `Flagged as: ${diagnosticMessage}\n\n` +
          `Write a single-line comment explaining why this is intentional and should not be changed.`,
      },
    ],
  });

  const result = (completion.choices[0]?.message?.content ?? "").trim();
  logger.log(`\n--- response ---\n${result}`);
  logger.show();
  return result;
}
