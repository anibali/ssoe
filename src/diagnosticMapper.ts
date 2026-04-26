import * as vscode from "vscode";
import * as logger from "./logger";

/**
 * Resolve the precise location of an issue within the file text.
 * Uses the context and verbatim strings to find exact character positions.
 *
 * @param fileText The full text of the file
 * @param diagnostic The diagnostic with context and verbatim fields
 * @returns vscode.Range with precise location, or undefined if not found
 */
export function resolveIssueLocation(
  fileText: string,
  diagnostic: { context: string; verbatim: string }
): vscode.Range | undefined {
  const { context, verbatim } = diagnostic;

  // Find the context in the file
  const contextIndex = fileText.indexOf(context);
  if (contextIndex === -1) {
    logger.log(`DiagnosticMapper: context not found in file`);
    return undefined;
  }

  // Find the verbatim text within the context region
  const contextEndIndex = contextIndex + context.length;
  const verbatimIndex = fileText.indexOf(verbatim, contextIndex);

  if (verbatimIndex === -1 || verbatimIndex >= contextEndIndex) {
    logger.log(`DiagnosticMapper: verbatim not found within context`);
    return undefined;
  }

  // Convert character indices to line/character positions
  const startPos = indexToPosition(fileText, verbatimIndex);
  const endPos = indexToPosition(fileText, verbatimIndex + verbatim.length);

  return new vscode.Range(startPos, endPos);
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
