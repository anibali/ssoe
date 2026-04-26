import * as vscode from "vscode";
import { getIntentDoc, getCodeFix } from "./llmClient";
import { diagnosticCollection } from "./extension";
import * as logger from "./logger";

/** Extract first line from a string (cut at first newline) */
function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx === -1 ? text : text.substring(0, idx);
}

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
      actions.push(this.makeCodeFix(document, diagnostic));
      actions.push(this.makeIntentDoc(document, diagnostic));
    }

    return actions;
  }

  private makeCodeFix(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      `🔨 SSOE: Fix code — ${firstLine(diagnostic.message)}`,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.command = {
      command: "ssoe.fixCode",
      title: "Fix code",
      arguments: [document, diagnostic],
    };
    return action;
  }

  private makeIntentDoc(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      `💬 SSOE: Document as intentional — ${firstLine(diagnostic.message)}`,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.command = {
      command: "ssoe.documentIntentional",
      title: "Document as intentional",
      arguments: [document, diagnostic],
    };
    return action;
  }
}

export async function applyCodeFix(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
): Promise<void> {
  // Capture document version BEFORE calling LLM
  const expectedVersion = document.version;

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "SSOE: Fix code…" },
    () =>
      getCodeFix(
        document,
        diagnostic,
        expectedVersion
      )
  );

  if (!result.success) {
    vscode.window.showErrorMessage(`SSOE fix code failed: ${result.message}`);
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

export async function applyIntentDoc(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
): Promise<void> {
  // Capture document version BEFORE calling LLM
  const expectedVersion = document.version;

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "SSOE: Generating comment…" },
    () =>
      getIntentDoc(
        document,
        diagnostic,
        expectedVersion
      )
  );

  if (!result.success) {
    vscode.window.showErrorMessage(`SSOE document intentional failed: ${result.message}`);
    return;
  }

  // Remove the diagnostic after documenting as intentional
  const currentDiagnostics = diagnosticCollection.get(document.uri);
  if (currentDiagnostics) {
    const newDiagnostics = currentDiagnostics.filter(
      (d) => !areDiagnosticsEqual(d, diagnostic)
    );
    diagnosticCollection.set(document.uri, newDiagnostics);
    logger.log(
      `Removed diagnostic after documenting as intentional: ${diagnostic.message} (${currentDiagnostics.length} → ${newDiagnostics.length})`
    );
  }

  vscode.window.showInformationMessage(`SSOE: ${result.message}`);
}
