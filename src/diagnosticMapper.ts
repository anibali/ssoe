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

  // Find the context in the file (exact first, then base-indent-offset fallback)
  let contextIndex = fileText.indexOf(context);
  let contextEndIndex: number;
  if (contextIndex !== -1) {
    contextEndIndex = contextIndex + context.length;
  } else {
    const match = findContextWithIndentOffset(fileText, context);
    if (match === null) {
      const error = "context not found in file";
      logger.log(`DiagnosticMapper: ${error}`);
      return { success: false, error };
    }
    contextIndex = match.start;
    contextEndIndex = match.end;
    logger.log(`DiagnosticMapper: context matched via indent-offset fallback`);
  }

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
 * Fallback context search: the model may drop the common base indent while preserving
 * relative indentation between lines. For each candidate position, compute the indent
 * offset that would make the first non-empty context line match the file line, then
 * verify all remaining lines match with that same offset applied.
 */
function findContextWithIndentOffset(
  fileText: string,
  context: string
): { start: number; end: number } | null {
  const contextLines = context.split("\n");
  const fileLines = fileText.split("\n");

  const firstNonEmpty = contextLines.findIndex((l) => l.trim().length > 0);
  if (firstNonEmpty === -1) return null;
  const ctxLeadLen = (contextLines[firstNonEmpty].match(/^(\s*)/)?.[1] ?? "").length;

  // Build cumulative char offsets for each file line
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of fileLines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }

  outer: for (let fi = 0; fi <= fileLines.length - contextLines.length; fi++) {
    // Determine base indent offset from the first non-empty context line
    const fileLine = fileLines[fi + firstNonEmpty];
    const fileLeadLen = (fileLine.match(/^(\s*)/)?.[1] ?? "").length;
    const indentOffset = fileLeadLen - ctxLeadLen;
    if (indentOffset < 0) continue;
    const prefix = " ".repeat(indentOffset);

    for (let ci = 0; ci < contextLines.length; ci++) {
      const expected = contextLines[ci].length === 0 ? "" : prefix + contextLines[ci];
      if (fileLines[fi + ci] !== expected) continue outer;
    }

    // All lines matched
    const start = lineOffsets[fi];
    const lastFileLine = fi + contextLines.length - 1;
    const end = lineOffsets[lastFileLine] + fileLines[lastFileLine].length;
    return { start, end };
  }

  return null;
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
