import * as vscode from "vscode";
import { getIntentDoc, getCodeFix } from "./llmClient";
import { diagnosticCollection } from "./extension";
import * as logger from "./logger";
import { randomUUID } from "crypto";

/** Extract first line from a string (cut at first newline) */
function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx === -1 ? text : text.substring(0, idx);
}

/**
 * Compare two diagnostics by value (range, message, source, severity)
 * since object references may differ after edit adjustments.
 * If both diagnostics have a `code` property with a URN target, compare by that.
 */
export function areDiagnosticsEqual(
  d1: vscode.Diagnostic,
  d2: vscode.Diagnostic
): boolean {
  // If both have code set, compare by code
  if (d1.code !== undefined && d2.code !== undefined) {
    const code1 = d1.code;
    const code2 = d2.code;

    // If both are objects with target, compare the target URIs
    if (typeof code1 === 'object' && typeof code2 === 'object' &&
        code1 !== null && code2 !== null) {
      const t1 = (code1 as any).target;
      const t2 = (code2 as any).target;
      if (t1 && t2 && t1.toString && t2.toString) {
        return t1.toString() === t2.toString();
      }
    }

    // For string/number codes, compare directly
    return code1 === code2;
  }

  // Fall back to value comparison
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

/**
 * Remove a diagnostic from the diagnostic collection for a given URI.
 * Uses value comparison since object references may differ after edit adjustments.
 */
export function removeDiagnostic(
  uri: vscode.Uri,
  diagnostic: vscode.Diagnostic,
  collection: vscode.DiagnosticCollection
): void {
  const currentDiagnostics = collection.get(uri);
  if (currentDiagnostics) {
    const newDiagnostics = currentDiagnostics.filter(
      (d) => !areDiagnosticsEqual(d, diagnostic)
    );
    collection.set(uri, newDiagnostics);
    logger.log(
      `Removed diagnostic: ${diagnostic.message} (${currentDiagnostics.length} → ${newDiagnostics.length})`
    );
  }
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
  removeDiagnostic(document.uri, diagnostic, diagnosticCollection);

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
  removeDiagnostic(document.uri, diagnostic, diagnosticCollection);

  vscode.window.showInformationMessage(`SSOE: ${result.message}`);
}
