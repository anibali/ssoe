import * as vscode from "vscode";
import OpenAI from "openai";

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
    apiKey: "not-needed", // llama.cpp doesn't require a key
  });

  return { client, model, maxTokens };
}

const SYSTEM_PROMPT = `You are an expert code reviewer acting as a semantic linter.
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

export async function scanFile(
  code: string,
  languageId: string
): Promise<LlmDiagnostic[]> {
  const { client, model, maxTokens } = getClient();

  const completion = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Language: ${languageId}\n\n\`\`\`${languageId}\n${code}\n\`\`\``,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "";
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

  return results;
}

export async function getSurgicalFix(
  code: string,
  lineNumber: number,
  lineText: string,
  diagnosticMessage: string,
  languageId: string
): Promise<string> {
  const { client, model } = getClient();

  const completion = await client.chat.completions.create({
    model,
    max_tokens: 256,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are fixing a single line of code. Return ONLY the corrected replacement line, preserving the exact indentation. No explanation, no markdown, no line numbers.",
      },
      {
        role: "user",
        content: `Language: ${languageId}
Line ${lineNumber} to fix: ${lineText}
Issue: ${diagnosticMessage}

Full file for context:
\`\`\`${languageId}
${code}
\`\`\``,
      },
    ],
  });

  return stripFences(completion.choices[0]?.message?.content ?? "");
}

export async function getJustificationComment(
  lineNumber: number,
  lineText: string,
  diagnosticMessage: string,
  languageId: string
): Promise<string> {
  const { client, model } = getClient();

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
        content: `You are writing a code comment to justify an intentional code pattern. Return ONLY the comment line starting with "${commentChar}". No explanation, no extra text.`,
      },
      {
        role: "user",
        content: `Language: ${languageId}
Line ${lineNumber}: ${lineText}
Flagged as: ${diagnosticMessage}

Write a single-line comment explaining why this is intentional and should not be changed.`,
      },
    ],
  });

  return (completion.choices[0]?.message?.content ?? "").trim();
}
