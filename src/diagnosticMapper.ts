import * as vscode from "vscode";
import * as logger from "./logger";
import { LlmIssue } from "./analysisCache";

/**
 * Normalize whitespace for fuzzy matching.
 * Replaces multiple whitespace (including newlines) with a single space.
 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Find the position of `context` in `fileContent`.
 * First tries exact match, then falls back to whitespace-normalized match.
 * Returns the index in fileContent where context starts, or -1 if not found.
 */
function findContextPosition(
  fileContent: string,
  context: string
): number {
  // Try exact match first
  let index = fileContent.indexOf(context);
  
  if (index !== -1) {
    return index;
  }
  
  // Fall back to normalized whitespace match
  const normalizedContent = normalizeWhitespace(fileContent);
  const normalizedContext = normalizeWhitespace(context);
  
  index = normalizedContent.indexOf(normalizedContext);
  
  if (index !== -1) {
    logger.log("DiagnosticMapper: context found via whitespace normalization");
    return index;
  }
  
  return -1;
}

/**
 * Find `verbatim` within a specific region of the file.
 * Returns the index where verbatim starts, or -1 if not found.
 */
function findVerbatimInRegion(
  fileContent: string,
  verbatim: string,
  regionStart: number,
  regionEnd: number
): number {
  // Search for verbatim within the region
  const region = fileContent.substring(regionStart, regionEnd);
  const indexInRegion = region.indexOf(verbatim);
  
  if (indexInRegion !== -1) {
    return regionStart + indexInRegion;
  }
  
  return -1;
}

/**
 * Convert a character index in fileContent to a vscode.Position.
 */
function indexToPosition(
  fileContent: string,
  index: number
): vscode.Position {
  const lines = fileContent.substring(0, index).split("\n");
  const line = lines.length - 1;
  const character = lines[lines.length - 1].length;
  return new vscode.Position(line, character);
}

/**
 * Resolve issue location using `context` and `verbatim` strings.
 * 
 * Algorithm:
 * 1. Find `context` in file (fuzzy match, allow whitespace differences)
 * 2. Within that region, find `verbatim` (exact match)
 * 3. Return exact `vscode.Range` for the `verbatim` text
 * 4. Return `null` if resolution fails
 * 
 * @param fileContent The full file content
 * @param issue The LlmIssue with context and verbatim
 * @param chunkRange Optional: narrow search to chunk region
 * @returns vscode.Range for the verbatim text, or null if resolution fails
 */
export function resolveIssueLocation(
  fileContent: string,
  issue: LlmIssue,
  chunkRange?: vscode.Range
): vscode.Range | null {
  const { context, verbatim } = issue;
  
  // Validate that verbatim exists in context (as stated in prompt)
  if (!context.includes(verbatim)) {
    logger.log(`DiagnosticMapper ERROR: verbatim not found in context`);
    logger.log(`  verbatim: "${verbatim}"`);
    logger.log(`  context: "${context.substring(0, 100)}..."`);
    return null;
  }
  
  // Determine search region
  let searchStart = 0;
  let searchEnd = fileContent.length;
  
  if (chunkRange) {
    // Convert chunkRange to character indices
    const lines = fileContent.split("\n");
    let charStart = 0;
    for (let i = 0; i < chunkRange.start.line; i++) {
      charStart += lines[i].length + 1; // +1 for newline
    }
    charStart += chunkRange.start.character;
    
    let charEnd = 0;
    for (let i = 0; i < chunkRange.end.line; i++) {
      charEnd += lines[i].length + 1;
    }
    charEnd += chunkRange.end.character;
    
    searchStart = charStart;
    searchEnd = charEnd;
  }
  
  // Step 1: Find context in file
  let contextIndex: number;
  
  if (chunkRange) {
    // Search within chunk region
    const regionContent = fileContent.substring(searchStart, searchEnd);
    const contextInRegion = regionContent.indexOf(context);
    
    if (contextInRegion !== -1) {
      contextIndex = searchStart + contextInRegion;
    } else {
      // Try normalized
      const normalizedRegion = normalizeWhitespace(regionContent);
      const normalizedContext = normalizeWhitespace(context);
      const normalizedIndex = normalizedRegion.indexOf(normalizedContext);
      
      if (normalizedIndex !== -1) {
        contextIndex = searchStart + normalizedIndex;
      } else {
        logger.log(`DiagnosticMapper ERROR: context not found in chunk region`);
        logger.log(`  context: "${context.substring(0, 100)}..."`);
        return null;
      }
    }
  } else {
    // Search entire file
    contextIndex = findContextPosition(fileContent, context);
    
    if (contextIndex === -1) {
      logger.log(`DiagnosticMapper ERROR: context not found in file`);
      logger.log(`  context: "${context.substring(0, 100)}..."`);
      return null;
    }
  }
  
  // Step 2: Find verbatim within context region
  const contextEnd = contextIndex + context.length;
  const verbatimIndex = findVerbatimInRegion(
    fileContent,
    verbatim,
    contextIndex,
    contextEnd
  );
  
  if (verbatimIndex === -1) {
    logger.log(`DiagnosticMapper ERROR: verbatim not found within context region`);
    logger.log(`  verbatim: "${verbatim}"`);
    logger.log(`  context region: ${contextIndex}-${contextEnd}`);
    return null;
  }
  
  // Step 3: Convert to vscode.Range
  const startPos = indexToPosition(fileContent, verbatimIndex);
  const endPos = indexToPosition(fileContent, verbatimIndex + verbatim.length);
  
  const range = new vscode.Range(startPos, endPos);
  
  logger.log(`DiagnosticMapper: resolved issue to range ${startPos.line + 1}:${startPos.character + 1}-${endPos.line + 1}:${endPos.character + 1}`);
  
  return range;
}
