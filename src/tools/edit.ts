import * as fs from "fs/promises";
import * as path from "path";

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
 * Resolves file paths relative to workspace root if needed.
 */
export async function executeEdit(
  input: EditToolInput,
  workspaceRoot?: string
): Promise<{ success: boolean; message: string; applied?: number }> {
  try {
    // Resolve path
    let filePath = input.path;
    if (workspaceRoot && !path.isAbsolute(filePath)) {
      filePath = path.join(workspaceRoot, filePath);
    }

    // Read file
    const content = await fs.readFile(filePath, "utf-8");

    // Apply edits
    const { result, applied } = applyEdits(content, input.edits);

    // Write back
    await fs.writeFile(filePath, result, "utf-8");

    return {
      success: true,
      message: `Successfully applied ${applied} edit(s) to ${input.path}`,
      applied,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
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
