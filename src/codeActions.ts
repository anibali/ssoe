import * as vscode from "vscode";
import { getJustificationComment, getToolBasedEdit } from "./llmClient";

export const SSOE_SOURCE = "SSOE";

export class SsoeCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.CodeAction[] {
    const diagnostics = vscode.languages
      .getDiagnostics(document.uri)
      .filter(
        (d) => d.source === SSOE_SOURCE && d.range.intersection(range)
      );

    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of diagnostics) {
      actions.push(this.makeToolBasedEdit(document, diagnostic));
      actions.push(this.makeJustificationComment(document, diagnostic));
    }

    return actions;
  }

  private makeToolBasedEdit(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      `🔨 SSOE: Smart Fix — ${diagnostic.message}`,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.command = {
      command: "ssoe.applyToolBasedEdit",
      title: "Apply smart fix using tool",
      arguments: [document, diagnostic],
    };
    return action;
  }

  private makeJustificationComment(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      `💬 SSOE: Justify — ${diagnostic.message}`,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.command = {
      command: "ssoe.applyJustificationComment",
      title: "Add justification comment",
      arguments: [document, diagnostic],
    };
    return action;
  }
}

export async function applyToolBasedEdit(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
): Promise<void> {
  const code = document.getText();
  const filePath = document.uri.fsPath;

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "SSOE: Smart fix using tool…" },
    () =>
      getToolBasedEdit(
        code,
        document.languageId,
        diagnostic.message,
        filePath
      )
  );

  if (!result.success) {
    vscode.window.showErrorMessage(`SSOE smart fix failed: ${result.message}`);
    return;
  }

  vscode.window.showInformationMessage(`SSOE: ${result.message}`);
}

export async function applyJustificationComment(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
): Promise<void> {
  const code = document.getText();
  const lineIndex = diagnostic.range.start.line;
  const lineText = document.lineAt(lineIndex).text;
  const filePath = document.uri.fsPath;

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "SSOE: Generating comment…" },
    () =>
      getJustificationComment(
        code,
        lineIndex + 1,
        lineText,
        diagnostic.message,
        document.languageId,
        filePath
      )
  );

  if (!result.success) {
    vscode.window.showErrorMessage(`SSOE justification comment failed: ${result.message}`);
    return;
  }

  vscode.window.showInformationMessage(`SSOE: ${result.message}`);
}
