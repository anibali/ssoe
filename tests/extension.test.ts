import { afterEach, describe, expect, test, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { processDocumentChange } from '../src/extension';
import { SSOE_SOURCE } from '../src/codeActions';

// Mock vscode using factory function
vi.mock('vscode', async () => (await import('jest-mock-vscode')).createVSCodeMock(vi));

// Simple stateful diagnostic collection for testing
class StatefulDiagnosticCollection implements vscode.DiagnosticCollection {
  private diagnostics = new Map<string, vscode.Diagnostic[]>();
  name = SSOE_SOURCE;

  get(uri: vscode.Uri): vscode.Diagnostic[] | undefined {
    return this.diagnostics.get(uri.toString());
  }

  set(uriOrEntries: vscode.Uri | readonly (readonly [vscode.Uri, readonly vscode.Diagnostic[] | undefined])[], diagnostics?: readonly vscode.Diagnostic[] | undefined): void {
    // Check if first argument is an array (entries overload) or a Uri
    if (Array.isArray(uriOrEntries)) {
      // Handle set(entries) overload
      for (const [uri, diags] of uriOrEntries) {
        if (diags === undefined || diags.length === 0) {
          this.diagnostics.set(uri.toString(), []);
        } else {
          this.diagnostics.set(uri.toString(), [...diags]);
        }
      }
    } else {
      // Handle set(uri, diagnostics) overload
      const uri = uriOrEntries;
      if (diagnostics === undefined || diagnostics.length === 0) {
        // Store empty array instead of deleting - matches VS Code behavior
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

describe('processDocumentChange', () => {
  let mockDiagnosticCollection: vscode.DiagnosticCollection;
  let mockDocument: vscode.TextDocument;
  let mockUri: vscode.Uri;

  beforeEach(() => {
    mockUri = vscode.Uri.file('/test/file.ts');

    mockDocument = {
      uri: mockUri,
      lineCount: 100,
      languageId: 'typescript',
    } as unknown as vscode.TextDocument;

    // Create a stateful diagnostic collection
    mockDiagnosticCollection = new StatefulDiagnosticCollection();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  test('should do nothing when no diagnostics exist', () => {
    const event = {
      document: mockDocument,
      contentChanges: [
        {
          range: new vscode.Range(5, 0, 5, 10),
          rangeLength: 10,
          text: 'new text',
        },
      ],
    } as unknown as vscode.TextDocumentChangeEvent;

    processDocumentChange(event, mockDiagnosticCollection);

    // No diagnostics were set, so get should return undefined
    expect(mockDiagnosticCollection.get(mockUri)).toBeUndefined();
  });

  test('should do nothing when diagnostics array is empty', () => {
    // Set empty array
    mockDiagnosticCollection.set(mockUri, []);

    const event = {
      document: mockDocument,
      contentChanges: [
        {
          range: new vscode.Range(5, 0, 5, 10),
          rangeLength: 10,
          text: 'new text',
        },
      ],
    } as unknown as vscode.TextDocumentChangeEvent;

    processDocumentChange(event, mockDiagnosticCollection);

    // Should still be empty
    expect(mockDiagnosticCollection.get(mockUri)).toEqual([]);
  });

  test('should not update diagnostics when edit does not affect them', () => {
    // Diagnostic at line 10, characters 0-20
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(10, 0, 10, 20),
      'Test issue',
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = SSOE_SOURCE;

    // Set the diagnostic
    mockDiagnosticCollection.set(mockUri, [diagnostic]);

    // Edit on line 5, adding 1 character (rangeLength=10, text length=11)
    const event = {
      document: mockDocument,
      contentChanges: [
        {
          range: new vscode.Range(5, 0, 5, 10),
          rangeLength: 10,
          text: 'new text!!', // 11 chars, so charDelta = 1
        },
      ],
    } as unknown as vscode.TextDocumentChangeEvent;

    processDocumentChange(event, mockDiagnosticCollection);

    // Diagnostic at line 10 is unaffected (edit was at line 5 with no line changes)
    // The function should not update diagnostics that don't need changes
    const diagnostics = mockDiagnosticCollection.get(mockUri);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics![0].range.start.line).toBe(10);
  });

  test('should adjust diagnostics after multi-line insertion', () => {
    // Diagnostic at line 10, characters 0-20
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(10, 0, 10, 20),
      'Test issue',
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = SSOE_SOURCE;

    // Set the diagnostic
    mockDiagnosticCollection.set(mockUri, [diagnostic]);

    // Insert 2 new lines (rangeLength=0 for insertion, text has 2 newlines)
    const event = {
      document: mockDocument,
      contentChanges: [
        {
          range: new vscode.Range(5, 0, 5, 0),
          rangeLength: 0,
          text: 'line1\nline2\nline3', // 2 newlines, so deltaLines = 2
        },
      ],
    } as unknown as vscode.TextDocumentChangeEvent;

    processDocumentChange(event, mockDiagnosticCollection);

    // Diagnostic should be adjusted by 2 lines
    const diagnostics = mockDiagnosticCollection.get(mockUri);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics![0].range.start.line).toBe(12); // 10 + 2
  });

  test('should remove diagnostics that overlap with edit', () => {
    // Diagnostic overlaps with edit
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(5, 5, 5, 15),
      'Overlapping issue',
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = SSOE_SOURCE;

    // Set the diagnostic
    mockDiagnosticCollection.set(mockUri, [diagnostic]);

    const event = {
      document: mockDocument,
      contentChanges: [
        {
          range: new vscode.Range(5, 0, 5, 10),
          rangeLength: 10,
          text: 'replacement text',
        },
      ],
    } as unknown as vscode.TextDocumentChangeEvent;

    processDocumentChange(event, mockDiagnosticCollection);

    // Overlapping diagnostic should be removed
    expect(mockDiagnosticCollection.get(mockUri)).toEqual([]);
  });

  test('should not adjust diagnostics before the edit', () => {
    // Diagnostic before edit at line 3
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(3, 0, 3, 20),
      'Before edit',
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = SSOE_SOURCE;

    // Set the diagnostic
    mockDiagnosticCollection.set(mockUri, [diagnostic]);

    const event = {
      document: mockDocument,
      contentChanges: [
        {
          range: new vscode.Range(5, 0, 5, 10),
          rangeLength: 10,
          text: 'new text',
        },
      ],
    } as unknown as vscode.TextDocumentChangeEvent;

    processDocumentChange(event, mockDiagnosticCollection);

    // Diagnostic before edit should be unchanged
    const diagnostics = mockDiagnosticCollection.get(mockUri);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics![0].range.start.line).toBe(3);
  });

  test('should handle multiple diagnostics with mixed positions', () => {
    // Diagnostic before edit at line 3
    const beforeEdit = new vscode.Diagnostic(
      new vscode.Range(3, 0, 3, 20),
      'Before edit',
      vscode.DiagnosticSeverity.Warning
    );
    beforeEdit.source = SSOE_SOURCE;

    // Diagnostic after edit at line 10
    const afterEdit = new vscode.Diagnostic(
      new vscode.Range(10, 0, 10, 20),
      'After edit',
      vscode.DiagnosticSeverity.Error
    );
    afterEdit.source = SSOE_SOURCE;

    // Diagnostic overlapping with edit at line 5
    const overlapping = new vscode.Diagnostic(
      new vscode.Range(5, 5, 5, 15),
      'Overlapping',
      vscode.DiagnosticSeverity.Information
    );
    overlapping.source = SSOE_SOURCE;

    // Set all diagnostics
    mockDiagnosticCollection.set(mockUri, [beforeEdit, afterEdit, overlapping]);

    const event = {
      document: mockDocument,
      contentChanges: [
        {
          range: new vscode.Range(5, 0, 5, 10),
          rangeLength: 10,
          text: 'new text', // charDelta = 3 (13 - 10)
        },
      ],
    } as unknown as vscode.TextDocumentChangeEvent;

    processDocumentChange(event, mockDiagnosticCollection);

    // Should have 2 diagnostics: before and after edit (overlapping removed)
    const diagnostics = mockDiagnosticCollection.get(mockUri);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics![0].message).toBe('Before edit');
    expect(diagnostics![1].message).toBe('After edit');
  });

  test('should handle multiple edits sorted correctly', () => {
    // Diagnostic far after edits at line 20
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(20, 0, 20, 20),
      'Far after edits',
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = SSOE_SOURCE;

    // Set the diagnostic
    mockDiagnosticCollection.set(mockUri, [diagnostic]);

    const event = {
      document: mockDocument,
      contentChanges: [
        {
          range: new vscode.Range(5, 0, 5, 10),
          rangeLength: 10,
          text: 'text1\ntext2', // 1 newline, deltaLines = 1
        },
        {
          range: new vscode.Range(15, 0, 15, 5),
          rangeLength: 5,
          text: 'replacement', // no newlines, charDelta = 6
        },
      ],
    } as unknown as vscode.TextDocumentChangeEvent;

    processDocumentChange(event, mockDiagnosticCollection);

    // Diagnostic at line 20 should be adjusted by 1 line
    const diagnostics = mockDiagnosticCollection.get(mockUri);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics![0].range.start.line).toBe(21); // 20 + 1
  });

  test('should remove diagnostic if adjustment leads to invalid position', () => {
    // Diagnostic at line 99
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(99, 0, 99, 20),
      'Last line',
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = SSOE_SOURCE;

    // Set the diagnostic
    mockDiagnosticCollection.set(mockUri, [diagnostic]);

    // Delete lines so diagnostic goes out of bounds
    // Diagnostic at line 99, after deleting lines 5-95 (deltaLines = -90)
    // Adjusted line = 99 - 90 = 9, but set lineCount to 5 so line 9 is out of bounds
    const event = {
      document: { ...mockDocument, lineCount: 5 },
      contentChanges: [
        {
          range: new vscode.Range(5, 0, 95, 0),
          rangeLength: 0,
          text: '', // Deletes many lines
        },
      ],
    } as unknown as vscode.TextDocumentChangeEvent;

    processDocumentChange(event, mockDiagnosticCollection);

    // Diagnostic should be removed (out of bounds)
    expect(mockDiagnosticCollection.get(mockUri)).toEqual([]);
  });

  test('should skip changes with no net effect', () => {
    // Diagnostic at line 10, characters 0-20
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(10, 0, 10, 20),
      'Test issue',
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = SSOE_SOURCE;

    // Set the diagnostic
    mockDiagnosticCollection.set(mockUri, [diagnostic]);

    // Change with same number of lines and same character count
    const event = {
      document: mockDocument,
      contentChanges: [
        {
          range: new vscode.Range(5, 0, 5, 10),
          rangeLength: 10,
          text: '1234567890', // Same length, no newlines
        },
      ],
    } as unknown as vscode.TextDocumentChangeEvent;

    processDocumentChange(event, mockDiagnosticCollection);

    // Diagnostic should be unchanged
    const diagnostics = mockDiagnosticCollection.get(mockUri);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics![0].range.start.line).toBe(10);
  });

  test('should adjust character positions for diagnostics on same line after edit', () => {
    // Diagnostic at line 5, characters 15-25 (AFTER the edit range which is 0-10)
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(5, 15, 5, 25),
      'After edit on same line',
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = SSOE_SOURCE;

    // Set the diagnostic
    mockDiagnosticCollection.set(mockUri, [diagnostic]);

    // Edit on line 5, characters 0-10, replacing with text of different length
    // Old text: 10 chars, New text: 13 chars (charDelta = +3)
    const event = {
      document: mockDocument,
      contentChanges: [
        {
          range: new vscode.Range(5, 0, 5, 10),
          rangeLength: 10,
          text: 'new text!!', // 11 chars? Let me use 13 chars
        },
      ],
    } as unknown as vscode.TextDocumentChangeEvent;

    // Actually, let me use a clearer example with known values
    const event2 = {
      document: mockDocument,
      contentChanges: [
        {
          range: new vscode.Range(5, 0, 5, 10),
          rangeLength: 10,
          text: '1234567890123', // 13 chars, charDelta = +3
        },
      ],
    } as unknown as vscode.TextDocumentChangeEvent;

    processDocumentChange(event2, mockDiagnosticCollection);

    // Diagnostic is on same line (5) but starts AFTER the edit (15 > 10)
    // So it should be adjusted by charDelta = +3
    // Expected: start.char = 15 + 3 = 18, end.char = 25 + 3 = 28
    const diagnostics = mockDiagnosticCollection.get(mockUri);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics![0].range.start.line).toBe(5); // Same line
    expect(diagnostics![0].range.start.character).toBe(18); // 15 + 3
    expect(diagnostics![0].range.end.character).toBe(28); // 25 + 3
  });
});
