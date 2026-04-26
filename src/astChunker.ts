import * as vscode from "vscode";
import * as crypto from "crypto";
import * as logger from "./logger";

export interface CodeChunk {
  text: string; // The chunk source text
  hash: string; // Hash of text (for caching)
  range: vscode.Range; // Location in the file
  type: "moduleContext" | "function" | "class" | "method" | "other";
  name?: string; // Optional: function/class name for debugging
}

export interface ChunkingResult {
  moduleContext: string; // Read-only context for prompts
  chunks: CodeChunk[]; // Chunks to analyze
}

/**
 * Simple hash function for caching
 */
function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Check if a document symbol is a function-like or class-like
 */
function getSymbolType(
  kind: vscode.SymbolKind
): "function" | "class" | "method" | "other" | null {
  switch (kind) {
    case vscode.SymbolKind.Function:
    case vscode.SymbolKind.Constructor:
      return "function";
    case vscode.SymbolKind.Class:
    case vscode.SymbolKind.Interface:
    case vscode.SymbolKind.Enum:
    case vscode.SymbolKind.Struct:
    case vscode.SymbolKind.TypeParameter:
      return "class";
    case vscode.SymbolKind.Method:
    case vscode.SymbolKind.Property:
      return "method";
    default:
      return "other";
  }
}

/**
 * Extract Python function/class signature to create a stub.
 * Returns the stub with "..." as body.
 */
function getStub(chunk: CodeChunk): string {
  const text = chunk.text;
  const lines = text.split("\n");
  
  // For Python, the signature is the first line (ends with colon)
  const firstLine = lines[0];
  
  // Get the indentation of the signature
  const indentMatch = firstLine.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : "";
  const bodyIndent = indent + "    "; // 4 more spaces for body
  
  // Return signature + "..." stub
  return firstLine + "\n" + bodyIndent + "...";
}

/**
 * Extract module context with stubs for chunks.
 * Collects all code NOT inside chunks, plus stubs showing
 * function/class signatures where each chunk is located.
 */
function extractModuleContext(
  document: vscode.TextDocument,
  chunks: CodeChunk[]
): string {
  if (chunks.length === 0) {
    return document.getText().trim();
  }

  // Sort chunks by start position
  const sortedChunks = [...chunks].sort((a, b) =>
    a.range.start.compareTo(b.range.start)
  );

  const lines = document.getText().split("\n");
  const moduleLines: string[] = [];
  let lastLine = 0;

  for (const chunk of sortedChunks) {
    const chunkStartLine = chunk.range.start.line;
    const chunkEndLine = chunk.range.end.line;

    // Add any code between last chunk and this chunk (preserve original newlines)
    if (chunkStartLine > lastLine) {
      const betweenLines = lines.slice(lastLine, chunkStartLine);
      moduleLines.push(...betweenLines);
    }

    // Add stub for this chunk (no extra newlines)
    const stub = getStub(chunk);
    moduleLines.push(stub);

    lastLine = chunkEndLine + 1;
  }

  // Add any code after the last chunk
  if (lastLine < lines.length) {
    moduleLines.push(...lines.slice(lastLine));
  }

  return moduleLines.join("\n").trim();
}

/**
 * Recursively collect all analyzable chunks from document symbols
 */
function collectChunks(
  document: vscode.TextDocument,
  symbols: vscode.DocumentSymbol[],
  chunks: CodeChunk[]
): void {
  for (const symbol of symbols) {
    const type = getSymbolType(symbol.kind);

    if (type === "function" || type === "class" || type === "method") {
      const text = document.getText(symbol.range);
      const hash = hashText(text);

      chunks.push({
        text,
        hash,
        range: symbol.range,
        type,
        name: symbol.name,
      });
    }

    // Recurse into children (e.g., methods inside a class)
    if (symbol.children && symbol.children.length > 0) {
      collectChunks(document, symbol.children, chunks);
    }
  }
}

/**
 * Chunk a file into analyzable pieces using VS Code's document symbol provider.
 *
 * @param document The VS Code text document to chunk
 * @returns ChunkingResult or null if chunking fails
 */
export async function chunkFile(
  document: vscode.TextDocument
): Promise<ChunkingResult | null> {
  try {
    // Get document symbols via VS Code command API
    // Note: "vscode.executeDocumentSymbolProvider" is the correct command
    logger.log("astChunker: requesting document symbols for " + document.uri.toString());
    const symbols = await vscode.commands.executeCommand<
      vscode.DocumentSymbol[]
    >("vscode.executeDocumentSymbolProvider", document.uri);
    
    logger.log("astChunker: symbols result: " + (symbols ? `got ${symbols.length} symbols` : "null/undefined"));

    if (!symbols || symbols.length === 0) {
      // No symbols found - treat entire file as one chunk
      const text = document.getText();
      return {
        moduleContext: "",
        chunks: [
          {
            text,
            hash: hashText(text),
            range: new vscode.Range(
              new vscode.Position(0, 0),
              document.lineAt(document.lineCount - 1).range.end
            ),
            type: "other",
            name: "entire-file",
          },
        ],
      };
    }

    // Collect all analyzable chunks
    const chunks: CodeChunk[] = [];
    collectChunks(document, symbols, chunks);

    // If no chunks found (edge case), treat as entire file
    if (chunks.length === 0) {
      const text = document.getText();
      return {
        moduleContext: "",
        chunks: [
          {
            text,
            hash: hashText(text),
            range: new vscode.Range(
              new vscode.Position(0, 0),
              document.lineAt(document.lineCount - 1).range.end
            ),
            type: "other",
            name: "entire-file",
          },
        ],
      };
    }

    // Extract module context with stubs for chunks
    const moduleContext = extractModuleContext(document, chunks);

    return { moduleContext, chunks };
  } catch (error) {
    logger.log("astChunker ERROR: " + (error instanceof Error ? error.message : String(error)));
    return null;
  }
}
