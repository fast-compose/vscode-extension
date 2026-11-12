import * as os from "os";
import * as vscode from "vscode";
import { PreviewPanel } from "./PreviewPanel";

/**
 * Opens a new GitHub issue for the Fast Compose engine or this extension, picked from a list, prefilled with a template
 * and the extension, engine, VS Code and OS versions. No code or file contents are sent; the reporter adds what they
 * choose.
 */
export async function reportIssue(context: vscode.ExtensionContext): Promise<void> {
    const picked = await vscode.window.showQuickPick(
        [
            {
                label: "Preview Problem",
                detail: "Wrong rendering, unsupported Compose API, parse or runtime errors (Fast Compose engine)",
                repository: "fast-compose",
            },
            {
                label: "Extension Problem",
                detail: "Preview panel, resources, other files, VS Code errors (Fast Compose Preview extension)",
                repository: "vscode-extension",
            },
        ],
        { title: "Report Issue" },
    );
    if (!picked) return;
    const url = `https://github.com/fast-compose/${picked.repository}/issues/new`;
    await vscode.env.openExternal(vscode.Uri.parse(`${url}?body=${encodeURIComponent(body(context))}`));
}

function body(context: vscode.ExtensionContext): string {
    return [
        "**What happened**",
        "",
        "",
        "**Expected**",
        "",
        "",
        "**Code to reproduce**",
        "```kotlin",
        "",
        "```",
        "",
        "**Environment**",
        `- Fast Compose Preview: ${context.extension.packageJSON.version}`,
        `- Fast Compose engine: ${PreviewPanel.engineVersion ?? "unknown"}`,
        `- VS Code: ${vscode.version}`,
        `- OS: ${os.type()} ${os.release()} (${os.arch()})`,
    ].join("\n");
}
