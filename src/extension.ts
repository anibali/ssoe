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
              // Use precise range from diagnostic mapper if available
              let range: vscode.Range;

              if (d.range) {
                // Precise range from verbatim + context
                range = d.range;
              } else {
                // Fallback: entire line (old behavior)
                const lineIndex = Math.max(0, d.line - 1);
                const line = editor.document.lineAt(
                  Math.min(lineIndex, editor.document.lineCount - 1)
                );
                range = new vscode.Range(
                  line.range.start,
                  line.range.end
                );
              }

              const severity =
                d.severity === "error"
                  ? vscode.DiagnosticSeverity.Error
                  : d.severity === "info"
                  ? vscode.DiagnosticSeverity.Information
                  : vscode.DiagnosticSeverity.Warning;

              const diagnostic = new vscode.Diagnostic(
                range,
                d.message,
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
    const uri = event.document.uri;

    // Get current diagnostics for this file
    const currentDiagnostics = diagnosticCollection.get(uri);
    if (!currentDiagnostics || currentDiagnostics.length === 0) {
      return; // No diagnostics to update
    }

    let adjustedDiagnostics = [...currentDiagnostics];
    let changed = false;

    // Process changes from end to beginning to avoid position conflicts
    const sortedChanges = [...event.contentChanges].sort((a, b) => {
      return b.range.start.line - a.range.start.line;
    });

    for (const change of sortedChanges) {
      const editRange = change.range;

      // Calculate line delta (positive = lines added, negative = lines removed)
      const newLines = (change.text.match(/\n/g) || []).length;
      const oldLines = editRange.end.line - editRange.start.line;
      const deltaLines = newLines - oldLines;

      if (deltaLines === 0) {
        continue; // No line change, skip
      }

      logger.log(`Edit at line(s) ${editRange.start.line + 1}-${editRange.end.line + 1}: delta = ${deltaLines} lines`);

      // Adjust diagnostics that are after the edit
      const updated = adjustedDiagnostics.map(d => {
        if (d.range.end.line >= editRange.end.line) {
          // Shift this diagnostic by deltaLines
          const newStartLine = d.range.start.line + deltaLines;
          const newEndLine = d.range.end.line + deltaLines;

          // Validate new position
          if (newStartLine < 0 || newEndLine >= event.document.lineCount) {
            logger.log(`Removing diagnostic at line ${d.range.start.line + 1} - invalid after edit`);
            return null;
          }

          const newRange = new vscode.Range(
            newStartLine,
            d.range.start.character,
            newEndLine,
            d.range.end.character
          );

          // Create new diagnostic with adjusted range
          const newDiag = new vscode.Diagnostic(newRange, d.message, d.severity);
          newDiag.source = d.source;
          newDiag.code = d.code;
          return newDiag;
        }
        return d;
      }).filter(d => d !== null) as vscode.Diagnostic[];

      if (updated.length !== adjustedDiagnostics.length) {
        changed = true;
      }
      adjustedDiagnostics = updated;
    }

    // Update diagnostics if anything changed
    if (changed) {
      diagnosticCollection.set(uri, adjustedDiagnostics);
      logger.log(`Diagnostics adjusted after edit: ${currentDiagnostics.length} → ${adjustedDiagnostics.length}`);
    }
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
    fixCommand,
    commentCommand,
    codeActionProvider
  );
}

export function deactivate() {
  diagnosticCollection?.dispose();
}
