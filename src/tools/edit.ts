import * as path from "path";
import * as vscode from "vscode";
import * as logger from "../logger";

/**
 * Simplified version of pi-mono's edit tool.
 * Uses exact text matching: oldText must match uniquely in the file.
 */

export interface Edit {
  oldText: string;
  newText: string;
}

export interface EditToolInput {
  path: string;
  edits: Edit[];
}

/**
 * Tool definition for LLM tool calling (OpenAI format)
 */
export const EDIT_TOOL = {
  type: "function" as const,
  function: {
    name: "edit_file",
    description:
      "Edit a file using exact text replacement. Each edit replaces oldText with newText. " +
      "oldText must match exactly and uniquely in the file. " +
      "For multiple changes, include multiple edits in one call rather than calling the tool multiple times. " +
      "Keep oldText as small as possible while still being unique.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to edit (relative or absolute)",
        },
        edits: {
          type: "array",
          description: "One or more targeted replacements",
          items: {
            type: "object",
            properties: {
              oldText: {
                type: "string",
                description:
                  "Exact text to find and replace. Must be unique in the file. Keep it minimal but unambiguous.",
              },
              newText: {
                type: "string",
                description: "Replacement text",
              },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },
};

/**
 * Apply edits to file content.
 * Each edit's oldText is matched against the ORIGINAL file content (not incremental).
 */
function applyEdits(content: string, edits: Edit[]): { result: string; applied: number } {
  let result = content;
  let applied = 0;

  for (const edit of edits) {
    const index = result.indexOf(edit.oldText);
    if (index === -1) {
      throw new Error(`oldText not found in file: ${edit.oldText.slice(0, 50)}...`);
    }

    // Check uniqueness
    const secondIndex = result.indexOf(edit.oldText, index + 1);
    if (secondIndex !== -1) {
      throw new Error(
        `oldText found multiple times in file (not unique): ${edit.oldText.slice(0, 50)}...`
      );
    }

    result = result.slice(0, index) + edit.newText + result.slice(index + edit.oldText.length);
    applied++;
  }

  return { result, applied };
}

/**
 * Execute the edit tool with the given input.
 * Uses VS Code document for in-memory editing.
 *
 * @param input - The edit tool input containing edits
 * @param document - VS Code document to edit
 * @param expectedVersion - Expected document version (fails if document changed)
 */
export async function executeEdit(
  input: EditToolInput,
  document: vscode.TextDocument,
  expectedVersion: number
): Promise<{ success: boolean; message: string; applied?: number; editedRanges?: Array<{ range: vscode.Range; lineDelta: number }> }> {
  try {
    return executeEditInDocument(input, document, expectedVersion);
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Execute edit in a VS Code document using in-memory buffer.
 * Detects if document changed during LLM processing.
 */
async function executeEditInDocument(
  input: EditToolInput,
  document: vscode.TextDocument,
  expectedVersion: number
): Promise<{ success: boolean; message: string; applied?: number; editedRanges?: Array<{ range: vscode.Range; lineDelta: number }> }> {
  // Check if document changed since we started
  if (document.version !== expectedVersion) {
    throw new Error(
      "Document changed while generating fix. Please re-select the quick fix to apply the edit."
    );
  }

  // Get in-memory content
  const content = document.getText();
  const editedRanges: Array<{ range: vscode.Range; lineDelta: number }> = [];

  // Calculate edited ranges and line deltas before applying
  let offset = 0;
  for (const edit of input.edits) {
    const index = content.indexOf(edit.oldText, offset);
    if (index !== -1) {
      const startPos = document.positionAt(index);
      const endPos = document.positionAt(index + edit.oldText.length);
      const oldLines = edit.oldText.split('\n').length;
      const newLines = edit.newText.split('\n').length;
      const lineDelta = newLines - oldLines;
      editedRanges.push({ range: new vscode.Range(startPos, endPos), lineDelta });
      offset = index + edit.oldText.length;
    }
  }

  // Apply edits to content
  let result: string;
  let applied: number;
  try {
    const applyResult = applyEdits(content, input.edits);
    result = applyResult.result;
    applied = applyResult.applied;
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // Log edited ranges for debugging
  logger.log('\n--- Edited ranges ---');
  for (const edited of editedRanges) {
    logger.log(`Range: ${edited.range.start.line}-${edited.range.end.line}, lineDelta: ${edited.lineDelta}`);
  }
  logger.show();

  // Create workspace edit - apply edits granularly using original positions
  // VS Code applies all edits atomically, so positions should be relative to original document
  const workspaceEdit = new vscode.WorkspaceEdit();

  // Map each edit to its original position in the document
  const editsWithPositions = input.edits.map((edit) => {
    const originalIndex = content.indexOf(edit.oldText);
    return { edit, originalIndex };
  });

  for (const { edit, originalIndex } of editsWithPositions) {
    if (originalIndex === -1) continue;

    const startPos = document.positionAt(originalIndex);
    const endPos = document.positionAt(originalIndex + edit.oldText.length);

    workspaceEdit.replace(document.uri, new vscode.Range(startPos, endPos), edit.newText);
  }

  // Apply the edit
  const success = await vscode.workspace.applyEdit(workspaceEdit);
  if (!success) {
    throw new Error("Failed to apply edit to document");
  }

  return {
    success: true,
    message: `Successfully applied ${applied} edit(s) to ${path.basename(document.uri.fsPath)}`,
    applied,
    editedRanges,
  };
}

/**
 * Parse tool call arguments from LLM response
 */
export function parseEditToolCall(toolCallArguments: string): EditToolInput {
  const parsed = JSON.parse(toolCallArguments);

  if (!parsed.path || !Array.isArray(parsed.edits) || parsed.edits.length === 0) {
    throw new Error("Invalid edit tool input: need path and edits array");
  }

  return parsed as EditToolInput;
}
