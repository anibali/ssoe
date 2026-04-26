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

let diagnosticCollection: vscode.DiagnosticCollection;

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
              // Line numbers from LLM are 1-indexed; VS Code is 0-indexed
              const lineIndex = Math.max(0, d.line - 1);
              const line = editor.document.lineAt(
                Math.min(lineIndex, editor.document.lineCount - 1)
              );
              const range = new vscode.Range(
                line.range.start,
                line.range.end
              );
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

  // ── Clear diagnostics when the file is edited ─────────────────────────────
  const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    diagnosticCollection.delete(event.document.uri);
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
