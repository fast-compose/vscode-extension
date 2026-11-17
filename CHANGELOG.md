# Changelog

Each version's section is the extension's change notes: one `- ` line per change.

## 0.3.0

- Fast Compose 0.3.0.
- Multi-preview annotations: AndroidX's `@PreviewLightDark`, `@PreviewScreenSizes`, `@PreviewFontScale` and your own annotation classes annotated with `@Preview`s.
- `@PreviewParameter`: one preview per value of the provider, up to `limit`.
- Names declared in two files of a package, such as a `data class Message` and a `fun Message(…)`, load both.

## 0.2.0

- First release: renders `@Preview` functions of the active Kotlin file as you type, with Fast Compose 0.2.0.
- Preview panel beside the editor, following the active Kotlin editor and its unsaved text.
- Device and Zoom bar below the previews: Phone, Foldable, Tablet or Desktop size; Fit, 50 %, 75 %, 100 % or 150 %, − and +, and Ctrl + mouse wheel. Saved per workspace.
- Preview link above every `@Preview` function, opening the preview at that function.
- Android and Kotlin Multiplatform projects: code from other files and the modules a file depends on, `expect` declarations from their JVM or Android `actual`, images and strings from `R` and `Res` across modules.
- Network images with Coil, cached on disk.
- Logs pane with parse errors, runtime errors and `println` output; other files' problems behind a toggle.
- Refresh and Report Issue buttons; crashes show in the logs instead of an empty panel.
- Runs only while visible, and only for files with a `@Preview`; shown again after VS Code restarts.
