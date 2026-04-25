import * as vscode from "vscode";
import { getSurgicalFix, getJustificationComment } from "./llmClient";

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
      actions.push(this.makeSurgicalFix(document, diagnostic));
      actions.push(this.makeJustificationComment(document, diagnostic));
    }

    return actions;
  }

  private makeSurgicalFix(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      `🔧 SSOE: Fix — ${diagnostic.message}`,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.command = {
      command: "ssoe.applySurgicalFix",
      title: "Apply surgical fix",
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

export async function applySurgicalFix(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
): Promise<void> {
  const lineIndex = diagnostic.range.start.line; // 0-indexed
  const lineText = document.lineAt(lineIndex).text;
  const code = document.getText();

  const replacement = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "SSOE: Generating fix…" },
    () =>
      getSurgicalFix(
        code,
        lineIndex + 1, // LLM sees 1-indexed
        lineText,
        diagnostic.message,
        document.languageId
      )
  );

  if (!replacement) {
    vscode.window.showWarningMessage("SSOE: LLM returned an empty fix.");
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, document.lineAt(lineIndex).range, replacement);
  await vscode.workspace.applyEdit(edit);
}

export async function applyJustificationComment(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
): Promise<void> {
  const lineIndex = diagnostic.range.start.line;
  const lineText = document.lineAt(lineIndex).text;

  // Detect indentation of the flagged line so the comment aligns with it
  const indent = lineText.match(/^(\s*)/)?.[1] ?? "";

  const comment = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "SSOE: Generating comment…" },
    () =>
      getJustificationComment(
        lineIndex + 1,
        lineText,
        diagnostic.message,
        document.languageId
      )
  );

  if (!comment) {
    vscode.window.showWarningMessage("SSOE: LLM returned an empty comment.");
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  const insertPosition = new vscode.Position(lineIndex, 0);
  edit.insert(document.uri, insertPosition, `${indent}${comment}\n`);
  await vscode.workspace.applyEdit(edit);
}
