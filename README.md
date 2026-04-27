_Disclaimer: This project was developed with heavy AI assistance_

# Second Set of Eyes (SSOE)

A VS Code extension that acts as a "semantic linter" using LLMs to provide proactive, stable, and context-aware code diagnostics. Unlike rigid rule-based tools like MyPy and Ruff, SSOE uses AI to catch logic issues and subtle bugs that traditional linters miss.

## Configuration

Add to your VS Code `settings.json`:

```json
{
  "ssoe.apiKey": "not-needed",
  "ssoe.llmBaseUrl": "http://localhost:1234",
  "ssoe.llmModel": "unsloth/gemma-4-E2B-it-GGUF:Q4_K_M",
}
```
