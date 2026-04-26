import * as vscode from "vscode";
import { scanFile } from "./llmClient";
import {
  SsoeCodeActionProvider,
  SSOE_SOURCE,
  applyJustificationComment,
  applyToolBasedEdit,
} from "./codeActions";
import * as logger from "./logger";

const SUPPORTED_LANGUAGES = [
  "python",
  "javascript",
  "typescript",
  "javascriptreact",
  "typescriptreact",
];

export let diagnosticCollection: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
  logger.init(context);

  diagnosticCollection =
    vscode.languages.createDiagnosticCollection(SSOE_SOURCE);
  context.subscriptions.push(diagnosticCollection);

  // ── Clear diagnostics on file close/open (catches reload) ─────────
  const closeListener = vscode.workspace.onDidCloseTextDocument((document) => {
    const filePath = document.uri.fsPath;
    if (diagnosticCollection.has(document.uri)) {
      logger.log(`Clearing diagnostics on close: ${filePath}`);
      diagnosticCollection.delete(document.uri);
    }
  });

  const openListener = vscode.workspace.onDidOpenTextDocument((document) => {
    const filePath = document.uri.fsPath;
    if (diagnosticCollection.has(document.uri)) {
      logger.log(`Clearing stale diagnostics on open: ${filePath}`);
      diagnosticCollection.delete(document.uri);
    }
  });

  // ── Command: scan the current file ────────────────────────────────────────
  const scanCommand = vscode.commands.registerCommand(
    "ssoe.scanFile",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("SSOE: No active editor.");
        return;
      }
      if (!SUPPORTED_LANGUAGES.includes(editor.document.languageId)) {
        vscode.window.showWarningMessage(
          `SSOE: Unsupported language "${editor.document.languageId}".`
        );
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "SSOE: Scanning file…",
          cancellable: false,
        },
        async () => {
          try {
            const diagnostics = await scanFile(editor.document);

            const vscodeDiagnostics = diagnostics.map((d) => {
              // Range is always present (only diagnostics with valid ranges are included)
              const range = d.range;

              const severity =
                d.severity === "error"
                  ? vscode.DiagnosticSeverity.Error
                  : d.severity === "info"
                  ? vscode.DiagnosticSeverity.Information
                  : vscode.DiagnosticSeverity.Warning;

              const diagnostic = new vscode.Diagnostic(
                range,
                `${d.description}\n\n${d.failure_scenario}`,
                severity
              );
              diagnostic.source = SSOE_SOURCE;
              return diagnostic;
            });

            diagnosticCollection.set(
              editor.document.uri,
              vscodeDiagnostics
            );

            const count = vscodeDiagnostics.length;
            vscode.window.showInformationMessage(
              count === 0
                ? "SSOE: No issues found."
                : `SSOE: Found ${count} issue${count === 1 ? "" : "s"}.`
            );
          } catch (err) {
            vscode.window.showErrorMessage(`SSOE: ${err}`);
          }
        }
      );
    }
  );

  // ── Update diagnostics on edit (adjust positions to stay in sync) ───────
  const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    processDocumentChange(event, diagnosticCollection);
  });

  // ── Command: apply tool-based fix ───────────────────────────────────────────
  const fixCommand = vscode.commands.registerCommand(
    "ssoe.applyToolBasedEdit",
    async (document: vscode.TextDocument, diagnostic: vscode.Diagnostic) => {
      try {
        await applyToolBasedEdit(document, diagnostic);
      } catch (err) {
        vscode.window.showErrorMessage(`SSOE smart fix failed: ${err}`);
      }
    }
  );

  // ── Command: add justification comment ────────────────────────────────────
  const commentCommand = vscode.commands.registerCommand(
    "ssoe.applyJustificationComment",
    async (document: vscode.TextDocument, diagnostic: vscode.Diagnostic) => {
      try {
        await applyJustificationComment(document, diagnostic);
      } catch (err) {
        vscode.window.showErrorMessage(`SSOE comment failed: ${err}`);
      }
    }
  );

  // ── Code action provider (lightbulb) ──────────────────────────────────────
  const codeActionProvider = vscode.languages.registerCodeActionsProvider(
    SUPPORTED_LANGUAGES.map((lang) => ({ language: lang })),
    new SsoeCodeActionProvider(),
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
  );

  context.subscriptions.push(
    scanCommand,
    changeListener,
    closeListener,
    openListener,
    fixCommand,
    commentCommand,
    codeActionProvider
  );
}

/**
 * Process a document change event and adjust diagnostics accordingly.
 * Exported for testing purposes.
 */
export function processDocumentChange(
  event: vscode.TextDocumentChangeEvent,
  diagCollection: vscode.DiagnosticCollection
): void {
  const uri = event.document.uri;

  // Get current diagnostics for this file
  const currentDiagnostics = diagCollection.get(uri);
  if (!currentDiagnostics || currentDiagnostics.length === 0) {
    return; // No diagnostics to update
  }

  const lineCount = event.document.lineCount;
  let adjustedDiagnostics = [...currentDiagnostics];
  let changed = false;

  // Process changes from end to beginning to avoid position conflicts
  const sortedChanges = [...event.contentChanges].sort((a, b) => {
    return b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character;
  });

  for (const change of sortedChanges) {
    const editRange = change.range;

    // Calculate deltas
    const oldTextLength = change.rangeLength;
    const newTextLength = change.text.length;
    const charDelta = newTextLength - oldTextLength;

    const newLines = (change.text.match(/\n/g) || []).length;
    const oldLines = editRange.end.line - editRange.start.line;
    const deltaLines = newLines - oldLines;

    if (deltaLines === 0 && charDelta === 0) {
      continue; // No change, skip
    }

    const updated: vscode.Diagnostic[] = [];

    for (const d of adjustedDiagnostics) {
      const diagStart = d.range.start;
      const diagEnd = d.range.end;

      // Check if diagnostic overlaps with the edit region
      const overlaps = d.range.intersection(editRange) ||
          (diagEnd.line === editRange.start.line && diagEnd.character > editRange.start.character) ||
          (diagStart.line === editRange.end.line && diagStart.character < editRange.end.character);

      if (overlaps) {
        logger.log(`Removing diagnostic at line ${diagStart.line + 1} - overlaps with edit`);
        changed = true;
        continue; // Skip this diagnostic (remove it)
      }

      // Diagnostic is after the edit region - adjust position
      if (diagStart.line > editRange.end.line ||
          (diagStart.line === editRange.end.line && diagStart.character >= editRange.end.character)) {

        let newStartLine = diagStart.line + deltaLines;
        let newEndLine = diagEnd.line + deltaLines;
        let newStartChar = diagStart.character;
        let newEndChar = diagEnd.character;

        // Adjust characters only if on the same line as edit end
        if (diagStart.line === editRange.end.line) {
          const charOffset = diagStart.character - editRange.end.character;
          newStartChar = Math.max(0, editRange.end.character + charOffset + charDelta);
        }
        if (diagEnd.line === editRange.end.line) {
          const charOffset = diagEnd.character - editRange.end.character;
          newEndChar = Math.max(0, editRange.end.character + charOffset + charDelta);
        }

        // Validate new position
        if (newStartLine < 0 || newEndLine >= lineCount) {
          logger.log(`Removing diagnostic at line ${diagStart.line + 1} - invalid after edit`);
          changed = true;
          continue;
        }

        const newRange = new vscode.Range(
          newStartLine,
          newStartChar,
          newEndLine,
          newEndChar
        );

        const newDiag = new vscode.Diagnostic(newRange, d.message, d.severity);
        newDiag.source = d.source;
        newDiag.code = d.code;
        updated.push(newDiag);
        changed = true;
        continue;
      }

      // Diagnostic is before the edit - keep as is
      updated.push(d);
    }

    adjustedDiagnostics = updated;
  }

  // Update diagnostics if anything changed
  if (changed) {
    diagCollection.set(uri, adjustedDiagnostics);
    logger.log(`Diagnostics adjusted after edit: ${currentDiagnostics.length} → ${adjustedDiagnostics.length}`);
  }
}

export function deactivate() {
  diagnosticCollection?.dispose();
}
