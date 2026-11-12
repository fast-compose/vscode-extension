import * as vscode from "vscode";
import { PreviewCodeLens } from "./codeLens";
import { PreviewPanel, VIEW_TYPE } from "./PreviewPanel";
import { reportIssue } from "./reportIssue";

/**
 * Registers the commands and the "Preview" CodeLens of Kotlin files, and shows the preview again after VS Code restarts
 * when it was open.
 */
export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("fastCompose.openPreview", () => PreviewPanel.show(context)),
        vscode.commands.registerCommand("fastCompose.revealPreview", (name: string) =>
            PreviewPanel.reveal(context, name),
        ),
        vscode.commands.registerCommand("fastCompose.refreshPreview", () => PreviewPanel.refresh()),
        vscode.commands.registerCommand("fastCompose.reportIssue", () => reportIssue(context)),
        vscode.languages.registerCodeLensProvider({ pattern: "**/*.kt" }, new PreviewCodeLens()),
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
                await PreviewPanel.restore(panel, context);
            },
        }),
    );
}

export function deactivate(): void {}
