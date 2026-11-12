import * as vscode from "vscode";

/** `@Preview`, or qualified as `@androidx.compose.ui.tooling.preview.Preview`. */
const PREVIEW = /@(?:[\w.]+\.)?Preview\b/g;

/** The function a preview annotation belongs to, after the annotation's arguments and other annotations. */
const FUNCTION = /^[^{}=]*?\bfun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)\s*\(/;

/** Declarations other than a function, which end the search for one. */
const OTHER_DECLARATION = /\b(?:class|object|interface|val|var)\b/;

/**
 * "Preview" above every `@Preview` function of a Kotlin file, once per function; it opens the preview and scrolls to
 * that function's preview. Annotations in comments, and on classes such as multi-preview annotations, are skipped.
 */
export class PreviewCodeLens implements vscode.CodeLensProvider {
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const text = document.getText();
        const lenses: vscode.CodeLens[] = [];
        const functions = new Set<string>();
        for (const match of text.matchAll(PREVIEW)) {
            const start = match.index!;
            const line = document.lineAt(document.positionAt(start).line);
            const before = line.text.substring(0, document.positionAt(start).character).trim();
            if (before.startsWith("//") || before.startsWith("*") || before.startsWith("/*")) continue;
            const after = text.substring(start + match[0].length, start + match[0].length + 2000);
            const found = FUNCTION.exec(after);
            if (!found || OTHER_DECLARATION.test(after.substring(0, found.index + found[0].length))) continue;
            const name = found[1];
            if (functions.has(name)) continue;
            functions.add(name);
            lenses.push(
                new vscode.CodeLens(line.range, {
                    title: "$(open-preview) Preview",
                    tooltip: `Show ${name} in Fast Compose Preview`,
                    command: "fastCompose.revealPreview",
                    arguments: [name],
                }),
            );
        }
        return lenses;
    }
}
