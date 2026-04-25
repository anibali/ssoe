# Second Set of Eyes (SSOE)

A VS Code extension that acts as a "semantic linter" using LLMs to provide proactive, stable, and context-aware code diagnostics. Unlike rigid rule-based tools like MyPy and Ruff, SSOE uses AI to catch logic issues, style problems, and subtle bugs that traditional linters miss.

## Features

### 1. Smart Caching & Stability
- **Block-Level Fingerprinting**: Hashes individual code blocks. Edit line 50, and the AI won't re-scan line 10. Existing hints stay stable.
- **Syntactic Resilience**: Scans code in chunks, providing feedback on "healthy" parts even when the file is mid-edit and syntactically broken.

### 2. Tool-base AI Fixes
The lightbulb menu (💡) offers two distinct paths:
- **Tool-based Fix**: The LLM rewrites the problematic line, matching your indentation, naming conventions (snake_case vs camelCase), and coding style.
- **Justification Comment**: Instead of cryptic `# type: ignore` tags, the AI writes a natural language comment explaining why the code is intentional. On future scans, the AI reads these comments and learns not to flag that line again.

### 3. Additional Tools
- **Refresh All Diagnostics**: Full re-scan of all open files
- **Re-verify with Context**: Re-scan considering current diagnostics as context
- **Clear Cache**: Reset all cached results

## Architecture

- **Temperature Locked to 0**: Ensures identical code gets identical feedback
- **DiagnosticCollection API**: Feels native to VS Code's Problems Pane
- **CodeActionProvider API**: Powers the lightbulb menu with fix actions
- **Chunk-Based Scanning**: Code is analyzed in configurable chunks (default 50 lines)

## Configuration

Add to your VS Code `settings.json`:

```json
{
  "ssoe.enabled": true,
  "ssoe.llmProvider": "openai-compatible",
  "ssoe.apiKey": "not-needed",
  "ssoe.llmBaseUrl": "http://localhost:1234",
  "ssoe.llmModel": "unsloth/gemma-4-E2B-it-GGUF:Q4_K_M",
  "ssoe.debounceMs": 2000,
  "ssoe.maxChunkLines": 50
}
```

## Usage

1. Open a supported file (Python, JavaScript, TypeScript)
2. SSOE automatically scans and shows diagnostics in the Problems Pane
3. Click the lightbulb (💡) on any SSOE diagnostic to see fix options:
   - 🔧 **Tool-based Fix**: Rewrites the line in-place
   - 💬 **Add Justification Comment**: Adds a comment explaining why the code is intentional

### Commands (Command Palette: Ctrl+Shift+P)

- `SSOE: Refresh All Diagnostics` - Full re-scan
- `SSOE: Re-verify with Current Diagnostics` - Context-aware re-scan

## How It Works

1. **Chunk Splitting**: Code is split into configurable chunks (default 50 lines)
2. **Fingerprinting**: Each chunk is hashed. If unchanged, cached diagnostics are reused
3. **LLM Analysis**: Chunks are sent to the LLM with a structured prompt requesting JSON output
4. **Diagnostic Display**: Results appear as red/yellow squiggles in the editor
5. **Fix Actions**: Lightbulb menu provides tool-based fixes and justification comments

## Example

Before SSOE:
```python
def calculate_total(items):
    total = 0
    for item in items:
        total += item.price * item.quantity
    # Forgot to return total!
```

After SSOE scan:
```
Problem: Variable 'total' is computed but never returned
Location: Line 6
Severity: Warning (style/logic)
```

Lightbulb options:
- 🔧 **Tool-based Fix** → Adds `return total` at line 6
- 💬 **Justification Comment** → Adds `# Intentionally not returning, side effects handled elsewhere`
