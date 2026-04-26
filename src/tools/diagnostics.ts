import * as vscode from "vscode";

/**
 * Diagnostic reporting tool for semantic linting scans.
 * Forces the LLM to return structured diagnostics via tool call.
 */

export interface DiagnosticToolInput {
  context: string;
  verbatim: string;
  description: string;
  failure_scenario: string;
  severity: "error" | "warning" | "info";
}

export const REPORT_DIAGNOSTICS_TOOL = {
  type: "function" as const,
  function: {
    name: "report_diagnostics",
    description:
      "Report a list of code diagnostics found during semantic linting. " +
      "Call this tool exactly once with ALL issues found in the file. " +
      "If no issues exist, call it with an empty array.",
    parameters: {
      type: "object",
      properties: {
        diagnostics: {
          type: "array",
          description: "All diagnostics found in the file (empty if none)",
          items: {
            type: "object",
            properties: {
              context: {
                type: "string",
                description: "A few surrounding lines to uniquely locate the issue in the file",
              },
              verbatim: {
                type: "string",
                description: "Exact problematic substring, verbatim within context",
              },
              description: {
                type: "string",
                description: "Short description of the issue",
              },
              failure_scenario: {
                type: "string",
                description: "Concrete completion of 'This will cause a problem when...'",
              },
              severity: {
                type: "string",
                enum: ["error", "warning", "info"],
                description: "Severity of the issue",
              },
            },
            required: ["context", "verbatim", "description", "failure_scenario", "severity"],
          },
        },
      },
      required: ["diagnostics"],
    },
  },
};

/**
 * Parse tool call arguments from the report_diagnostics tool
 */
export function parseDiagnosticsToolCall(toolCallArguments: string): DiagnosticToolInput[] {
  const parsed = JSON.parse(toolCallArguments);

  if (!Array.isArray(parsed.diagnostics)) {
    throw new Error("Invalid diagnostics tool input: missing diagnostics array");
  }

  return parsed.diagnostics as DiagnosticToolInput[];
}
