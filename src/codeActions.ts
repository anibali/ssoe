import * as vscode from "vscode";
import { getJustificationComment, getToolBasedEdit } from "./llmClient";
import { diagnosticCollection } from "./extension";
import * as logger from "./logger";

/**
 * Compare two diagnostics by value (range, message, source, severity)
 * since object references may differ after edit adjustments.
 */
function areDiagnosticsEqual(
  d1: vscode.Diagnostic,
  d2: vscode.Diagnostic
): boolean {
  // Compare range
  if (
    d1.range.start.line !== d2.range.start.line ||
    d1.range.start.character !== d2.range.start.character ||
    d1.range.end.line !== d2.range.end.line ||
    d1.range.end.character !== d2.range.end.character
  ) {
    return false;
  }
  // Compare message, source, and severity
  if (d1.message !== d2.message) return false;
  if (d1.source !== d2.source) return false;
  if (d1.severity !== d2.severity) return false;
  return true;
}

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
  // Capture document version BEFORE calling LLM
  const expectedVersion = document.version;

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "SSOE: Smart fix using tool…" },
    () =>
      getToolBasedEdit(
        document,
        diagnostic.message,
        expectedVersion
      )
  );

  if (!result.success) {
    vscode.window.showErrorMessage(`SSOE smart fix failed: ${result.message}`);
    return;
  }

  // Remove the diagnostic after successful fix
  const currentDiagnostics = diagnosticCollection.get(document.uri);
  if (currentDiagnostics) {
    // Filter out the diagnostic that was fixed using value comparison
    // (reference equality fails after edit adjustments create new objects)
    const newDiagnostics = currentDiagnostics.filter(
      (d) => !areDiagnosticsEqual(d, diagnostic)
    );
    diagnosticCollection.set(document.uri, newDiagnostics);
    logger.log(
      `Removed diagnostic after fix: ${diagnostic.message} (${currentDiagnostics.length} → ${newDiagnostics.length})`
    );
  }

  vscode.window.showInformationMessage(`SSOE: ${result.message}`);
}

export async function applyJustificationComment(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
): Promise<void> {
  // Capture document version BEFORE calling LLM
  const expectedVersion = document.version;

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "SSOE: Generating comment…" },
    () =>
      getJustificationComment(
        document,
        diagnostic,
        expectedVersion
      )
  );

  if (!result.success) {
    vscode.window.showErrorMessage(`SSOE justification comment failed: ${result.message}`);
    return;
  }

  // Remove the diagnostic after adding justification comment
  const currentDiagnostics = diagnosticCollection.get(document.uri);
  if (currentDiagnostics) {
    const newDiagnostics = currentDiagnostics.filter(
      (d) => !areDiagnosticsEqual(d, diagnostic)
    );
    diagnosticCollection.set(document.uri, newDiagnostics);
    logger.log(
      `Removed diagnostic after justification: ${diagnostic.message} (${currentDiagnostics.length} → ${newDiagnostics.length})`
    );
  }

  vscode.window.showInformationMessage(`SSOE: ${result.message}`);
}
