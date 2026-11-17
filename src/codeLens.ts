import * as vscode from "vscode";

/**
 * `@Preview`, qualified as `@androidx.compose.ui.tooling.preview.Preview`, or an annotation that may be a multi-preview
 * one: a name with `Preview` in it, such as `@PreviewLightDark` or `@DevicePreviews`. Group 1 is the name.
 */
const PREVIEW = /@(?:\w+\.)*(\w*Preview\w*)\b/g;

/** Annotations with `Preview` in their name that don't make previews. */
const NOT_PREVIEWS = new Set(["PreviewParameter"]);

/** The function a preview annotation belongs to, after the annotation's arguments and other annotations. */
const FUNCTION = /^[^{}=]*?\bfun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)\s*\(/;

/** Declarations other than a function, which end the search for one. */
const OTHER_DECLARATION = /\b(?:class|object|interface|val|var)\b/;

/**
 * "Preview" above every function with a `@Preview` or multi-preview annotation in a Kotlin file, once per function;
 * it opens the preview and scrolls to that function's first preview. Annotations in comments, on classes (such as
 * the multi-preview annotation classes themselves) and `@PreviewParameter` are skipped.
 */
export class PreviewCodeLens implements vscode.CodeLensProvider {
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const text = document.getText();
        const lenses: vscode.CodeLens[] = [];
        const functions = new Set<string>();
        for (const match of text.matchAll(PREVIEW)) {
            if (NOT_PREVIEWS.has(match[1])) continue;
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
