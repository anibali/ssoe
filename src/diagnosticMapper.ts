import * as vscode from "vscode";
import * as logger from "./logger";

/** Result type for resolveIssueLocation with detailed error info */
export type ResolveIssueResult =
  | { success: true; range: vscode.Range }
  | { success: false; error: string };

/**
 * Resolve the precise location of an issue within the file text.
 * Uses the context and verbatim strings to find exact character positions.
 *
 * @param fileText The full text of the file
 * @param diagnostic The diagnostic with context and verbatim fields
 * @returns ResolveIssueResult with range or error details
 */
export function resolveIssueLocation(
  fileText: string,
  diagnostic: { context: string; verbatim: string }
): ResolveIssueResult {
  const { context, verbatim } = diagnostic;

  // Find the context in the file
  const contextIndex = fileText.indexOf(context);
  if (contextIndex === -1) {
    const error = "context not found in file";
    logger.log(`DiagnosticMapper: ${error}`);
    return { success: false, error };
  }

  // Find the verbatim text within the context region
  const contextEndIndex = contextIndex + context.length;
  const verbatimIndex = fileText.indexOf(verbatim, contextIndex);

  if (verbatimIndex === -1 || verbatimIndex >= contextEndIndex) {
    const error = "verbatim not found within context";
    logger.log(`DiagnosticMapper: ${error}`);
    return { success: false, error };
  }

  // Convert character indices to line/character positions
  const startPos = indexToPosition(fileText, verbatimIndex);
  const endPos = indexToPosition(fileText, verbatimIndex + verbatim.length);

  return { success: true, range: new vscode.Range(startPos, endPos) };
}

/**
 * Convert a character index in the file text to a vscode.Position (line, character).
 */
function indexToPosition(text: string, index: number): vscode.Position {
  let line = 0;
  let charCount = 0;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (charCount + lines[i].length >= index) {
      return new vscode.Position(line, index - charCount);
    }
    charCount += lines[i].length + 1; // +1 for the newline character
    line++;
  }

  // Fallback: return end of file
  const lastLine = lines.length - 1;
  const lastChar = lines[lastLine]?.length ?? 0;
  return new vscode.Position(lastLine, lastChar);
}
