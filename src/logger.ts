import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function init(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel("SSOE");
  context.subscriptions.push(channel);
}

export function log(message: string): void {
  channel?.appendLine(message);
}

export function show(): void {
  channel?.show(true); // true = don't steal focus
}
