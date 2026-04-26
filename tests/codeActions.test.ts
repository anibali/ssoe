import { describe, expect, test, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { removeDiagnostic, areDiagnosticsEqual, SSOE_SOURCE } from '../src/codeActions';

// Mock vscode using factory function
vi.mock('vscode', async () => (await import('jest-mock-vscode')).createVSCodeMock(vi));

// Reuse the StatefulDiagnosticCollection from extension.test.ts
class StatefulDiagnosticCollection implements vscode.DiagnosticCollection {
  private diagnostics = new Map<string, vscode.Diagnostic[]>();
  name = SSOE_SOURCE;

  get(uri: vscode.Uri): vscode.Diagnostic[] | undefined {
    return this.diagnostics.get(uri.toString());
  }

  set(uriOrEntries: vscode.Uri | readonly (readonly [vscode.Uri, readonly vscode.Diagnostic[] | undefined])[], diagnostics?: readonly vscode.Diagnostic[] | undefined): void {
    if (Array.isArray(uriOrEntries)) {
      for (const [uri, diags] of uriOrEntries) {
        if (diags === undefined || diags.length === 0) {
          this.diagnostics.set(uri.toString(), []);
        } else {
          this.diagnostics.set(uri.toString(), [...diags]);
        }
      }
    } else {
      const uri = uriOrEntries;
      if (diagnostics === undefined || diagnostics.length === 0) {
        this.diagnostics.set(uri.toString(), []);
      } else {
        this.diagnostics.set(uri.toString(), [...diagnostics]);
      }
    }
  }

  has(uri: vscode.Uri): boolean {
    return this.diagnostics.has(uri.toString());
  }

  delete(uri: vscode.Uri): void {
    this.diagnostics.delete(uri.toString());
  }

  clear(): void {
    this.diagnostics.clear();
  }

  forEach() {
    // Not needed for tests
  }

  dispose(): void {
    this.diagnostics.clear();
  }

  [Symbol.iterator](): Iterator<[vscode.Uri, vscode.Diagnostic[]]> {
    const entries = Array.from(this.diagnostics.entries()).map(([uriStr, diags]) => [
      vscode.Uri.parse(uriStr),
      diags,
    ] as [vscode.Uri, vscode.Diagnostic[]]);
    return entries[Symbol.iterator]();
  }
}

describe('removeDiagnostic', () => {
  let mockDiagnosticCollection: vscode.DiagnosticCollection;
  let mockUri: vscode.Uri;
  let diagnostic1: vscode.Diagnostic;
  let diagnostic2: vscode.Diagnostic;

  beforeEach(() => {
    mockUri = vscode.Uri.file('/test/file.ts');
    mockDiagnosticCollection = new StatefulDiagnosticCollection();

    diagnostic1 = new vscode.Diagnostic(
      new vscode.Range(5, 0, 5, 20),
      'First issue',
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic1.source = SSOE_SOURCE;

    diagnostic2 = new vscode.Diagnostic(
      new vscode.Range(10, 0, 10, 20),
      'Second issue',
      vscode.DiagnosticSeverity.Error
    );
    diagnostic2.source = SSOE_SOURCE;
  });

  test('should remove a diagnostic that exists in the collection', () => {
    // Set up with both diagnostics
    mockDiagnosticCollection.set(mockUri, [diagnostic1, diagnostic2]);

    // Remove diagnostic1
    removeDiagnostic(mockUri, diagnostic1, mockDiagnosticCollection);

    // Should only have diagnostic2 left
    const remaining = mockDiagnosticCollection.get(mockUri);
    expect(remaining).toHaveLength(1);
    expect(remaining![0].message).toBe('Second issue');
  });

  test('should not affect other diagnostics when removing one', () => {
    mockDiagnosticCollection.set(mockUri, [diagnostic1, diagnostic2]);

    // Remove diagnostic1
    removeDiagnostic(mockUri, diagnostic1, mockDiagnosticCollection);

    // diagnostic2 should still be there with same properties
    const remaining = mockDiagnosticCollection.get(mockUri);
    expect(remaining).toHaveLength(1);
    expect(remaining![0].range.start.line).toBe(10);
    expect(remaining![0].range.end.character).toBe(20);
    expect(remaining![0].severity).toBe(vscode.DiagnosticSeverity.Error);
  });

  test('should do nothing when diagnostic does not exist in collection', () => {
    // Only set diagnostic1
    mockDiagnosticCollection.set(mockUri, [diagnostic1]);

    // Try to remove diagnostic2 (not in collection)
    removeDiagnostic(mockUri, diagnostic2, mockDiagnosticCollection);

    // Should still have diagnostic1 only
    const remaining = mockDiagnosticCollection.get(mockUri);
    expect(remaining).toHaveLength(1);
    expect(remaining![0].message).toBe('First issue');
  });

  test('should handle empty diagnostic collection', () => {
    // Don't set any diagnostics (collection is empty)
    // Should not throw
    expect(() => {
      removeDiagnostic(mockUri, diagnostic1, mockDiagnosticCollection);
    }).not.toThrow();

    // Collection should still be empty (undefined)
    expect(mockDiagnosticCollection.get(mockUri)).toBeUndefined();
  });

  test('should remove correct diagnostic when multiple have similar properties', () => {
    // Create two diagnostics with same message but different ranges
    const diag1 = new vscode.Diagnostic(
      new vscode.Range(5, 0, 5, 10),
      'Same message',
      vscode.DiagnosticSeverity.Warning
    );
    diag1.source = SSOE_SOURCE;

    const diag2 = new vscode.Diagnostic(
      new vscode.Range(10, 0, 10, 10),
      'Same message',
      vscode.DiagnosticSeverity.Warning
    );
    diag2.source = SSOE_SOURCE;

    mockDiagnosticCollection.set(mockUri, [diag1, diag2]);

    // Remove diag1 (based on range, not message)
    removeDiagnostic(mockUri, diag1, mockDiagnosticCollection);

    // Should only have diag2 left
    const remaining = mockDiagnosticCollection.get(mockUri);
    expect(remaining).toHaveLength(1);
    expect(remaining![0].range.start.line).toBe(10);
  });

  test('should use value comparison to match diagnostics after edits', () => {
    // Original diagnostic
    const originalDiag = new vscode.Diagnostic(
      new vscode.Range(5, 0, 5, 20),
      'Issue to fix',
      vscode.DiagnosticSeverity.Warning
    );
    originalDiag.source = SSOE_SOURCE;

    // Set it in collection
    mockDiagnosticCollection.set(mockUri, [originalDiag]);

    // Create a "new" diagnostic with same properties (simulating post-edit)
    // This won't be the same object reference, but has same values
    const postEditDiag = new vscode.Diagnostic(
      new vscode.Range(5, 0, 5, 20),
      'Issue to fix',
      vscode.DiagnosticSeverity.Warning
    );
    postEditDiag.source = SSOE_SOURCE;

    // Should still match and remove based on value comparison
    removeDiagnostic(mockUri, postEditDiag, mockDiagnosticCollection);

    // Collection should be empty
    const remaining = mockDiagnosticCollection.get(mockUri);
    expect(remaining).toEqual([]);
  });

  test('should handle diagnostic with different source', () => {
    const ssoeDiag = new vscode.Diagnostic(
      new vscode.Range(5, 0, 5, 20),
      'SSOE issue',
      vscode.DiagnosticSeverity.Warning
    );
    ssoeDiag.source = SSOE_SOURCE;

    const otherDiag = new vscode.Diagnostic(
      new vscode.Range(5, 0, 5, 20),
      'SSOE issue',
      vscode.DiagnosticSeverity.Warning
    );
    otherDiag.source = 'OtherLinter';

    mockDiagnosticCollection.set(mockUri, [ssoeDiag, otherDiag]);

    // Remove by value - since areDiagnosticsEqual compares source, only ssoeDiag should match
    removeDiagnostic(mockUri, ssoeDiag, mockDiagnosticCollection);

    // otherDiag should remain (different source)
    const remaining = mockDiagnosticCollection.get(mockUri);
    expect(remaining).toHaveLength(1);
    expect(remaining![0].source).toBe('OtherLinter');
  });

  test('should remove diagnostic even after it was adjusted by document change', () => {
    // Diagnostic at line 5
    const originalDiagnostic = new vscode.Diagnostic(
      new vscode.Range(5, 0, 5, 20),
      'Issue to fix',
      vscode.DiagnosticSeverity.Warning
    );
    originalDiagnostic.source = SSOE_SOURCE;
    // Assign a unique code (as extension.ts now does)
    // value is last 7 chars of UUID, target is the full URN
    const uuid = '12345-67890-unique-uuid-for-testing';
    const shortId = uuid.slice(-7); // "esting"
    originalDiagnostic.code = {
      value: shortId,
      target: vscode.Uri.parse(`urn:ssoe:${uuid}`)
    };

    // Set it in collection
    mockDiagnosticCollection.set(mockUri, [originalDiagnostic]);

    // Simulate what happens after a fix is applied:
    // 1. An edit happens BEFORE the diagnostic (at line 3), adding a new line
    // 2. processDocumentChange adjusts the diagnostic from line 5 to line 6
    // 3. removeDiagnostic is called with the ORIGINAL diagnostic (line 5)
    
    // Manually adjust the diagnostic in the collection (simulating processDocumentChange)
    // Note: processDocumentChange preserves the `code` property
    const adjustedDiagnostic = new vscode.Diagnostic(
      new vscode.Range(6, 0, 6, 20), // Line adjusted from 5 to 6!
      originalDiagnostic.message,
      originalDiagnostic.severity
    );
    adjustedDiagnostic.source = SSOE_SOURCE;
    // Preserve the code object (as processDocumentChange does)
    adjustedDiagnostic.code = originalDiagnostic.code;
    mockDiagnosticCollection.set(mockUri, [adjustedDiagnostic]);

    // Now try to remove using the ORIGINAL diagnostic (which has old range)
    removeDiagnostic(mockUri, originalDiagnostic, mockDiagnosticCollection);

    // Should now succeed because areDiagnosticsEqual matches by `code`
    const remaining = mockDiagnosticCollection.get(mockUri);
    expect(remaining).toEqual([]);
  });

  test('should handle diagnostic that was already removed by processDocumentChange', () => {
    // Diagnostic at line 5, characters 0-20
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(5, 0, 5, 20),
      'Issue to fix',
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = SSOE_SOURCE;

    mockDiagnosticCollection.set(mockUri, [diagnostic]);

    // Simulate: the fix edits the exact range of the diagnostic,
    // causing processDocumentChange to REMOVE it (because edits within
    // diagnostic range cause removal)
    // After this, the collection is empty
    mockDiagnosticCollection.set(mockUri, []);

    // removeDiagnostic should handle this gracefully (no-op)
    expect(() => {
      removeDiagnostic(mockUri, diagnostic, mockDiagnosticCollection);
    }).not.toThrow();

    expect(mockDiagnosticCollection.get(mockUri)).toEqual([]);
  });
});

describe('areDiagnosticsEqual', () => {
  test('should return true for diagnostics with same range, message, source, and severity', () => {
    const diag1 = new vscode.Diagnostic(
      new vscode.Range(5, 0, 5, 20),
      'Same message',
      vscode.DiagnosticSeverity.Warning
    );
    diag1.source = SSOE_SOURCE;

    const diag2 = new vscode.Diagnostic(
      new vscode.Range(5, 0, 5, 20),
      'Same message',
      vscode.DiagnosticSeverity.Warning
    );
    diag2.source = SSOE_SOURCE;

    expect(areDiagnosticsEqual(diag1, diag2)).toBe(true);
  });

  test('should return false for diagnostics with different ranges', () => {
    const diag1 = new vscode.Diagnostic(
      new vscode.Range(5, 0, 5, 20),
      'Same message',
      vscode.DiagnosticSeverity.Warning
    );
    diag1.source = SSOE_SOURCE;

    const diag2 = new vscode.Diagnostic(
      new vscode.Range(10, 0, 10, 20),
      'Same message',
      vscode.DiagnosticSeverity.Warning
    );
    diag2.source = SSOE_SOURCE;

    expect(areDiagnosticsEqual(diag1, diag2)).toBe(false);
  });

  test('should return false for diagnostics with different messages', () => {
    const diag1 = new vscode.Diagnostic(
      new vscode.Range(5, 0, 5, 20),
      'Message 1',
      vscode.DiagnosticSeverity.Warning
    );
    diag1.source = SSOE_SOURCE;

    const diag2 = new vscode.Diagnostic(
      new vscode.Range(5, 0, 5, 20),
      'Message 2',
      vscode.DiagnosticSeverity.Warning
    );
    diag2.source = SSOE_SOURCE;

    expect(areDiagnosticsEqual(diag1, diag2)).toBe(false);
  });

  test('should return false for diagnostics with different sources', () => {
    const diag1 = new vscode.Diagnostic(
      new vscode.Range(5, 0, 5, 20),
      'Same message',
      vscode.DiagnosticSeverity.Warning
    );
    diag1.source = 'Source1';

    const diag2 = new vscode.Diagnostic(
      new vscode.Range(5, 0, 5, 20),
      'Same message',
      vscode.DiagnosticSeverity.Warning
    );
    diag2.source = 'Source2';

    expect(areDiagnosticsEqual(diag1, diag2)).toBe(false);
  });

  test('should return false for diagnostics with different severities', () => {
    const diag1 = new vscode.Diagnostic(
      new vscode.Range(5, 0, 5, 20),
      'Same message',
      vscode.DiagnosticSeverity.Warning
    );
    diag1.source = SSOE_SOURCE;

    const diag2 = new vscode.Diagnostic(
      new vscode.Range(5, 0, 5, 20),
      'Same message',
      vscode.DiagnosticSeverity.Error
    );
    diag2.source = SSOE_SOURCE;

    expect(areDiagnosticsEqual(diag1, diag2)).toBe(false);
  });
});
