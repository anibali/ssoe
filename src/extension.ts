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

  // ── Remove diagnostics for edited region (smart persistence) ─────────
  const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    const uri = event.document.uri;
    const filePath = uri.fsPath;

    // Get current diagnostics for this file
    const currentDiagnostics = diagnosticCollection.get(uri);
    if (!currentDiagnostics || currentDiagnostics.length === 0) {
      return; // No diagnostics to remove
    }

    // Get the range of the edit
    for (const change of event.contentChanges) {
      const editRange = change.range;

      // Remove diagnostics that overlap with the edit
      const newDiagnostics = currentDiagnostics.filter(d => {
        // Check if diagnostic's range intersects with the edit range
        const overlaps = d.range.intersection(editRange) !== undefined;
        if (overlaps) {
          logger.log(`Removing diagnostic at ${d.range.start.line + 1}:${d.range.start.character + 1} due to edit`);
        }
        return !overlaps;
      });

      // Update diagnostics
      diagnosticCollection.set(uri, newDiagnostics);

      // If we removed something, invalidate cache for this file
      if (newDiagnostics.length < currentDiagnostics.length) {
        // Will be re-analyzed on next manual scan
        logger.log(`Diagnostics updated after edit, cache will be refreshed on next scan`);
      }

      break; // Only process first change for simplicity
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
