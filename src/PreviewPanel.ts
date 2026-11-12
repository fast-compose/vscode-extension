import * as vscode from "vscode";
import { ImageCache } from "./images";
import { findModules, Module } from "./modules";
import { FileChanges, listResources, pathOf, readFiles, readResource } from "./WorkspaceFiles";

/** A message from the webview; see `webview/src/wasmJsMain/kotlin/.../VsCode.kt`. */
type WebviewMessage =
    | { type: "ready"; engineVersion: string }
    | { type: "open"; path: string | null; line: number }
    | { type: "copy"; text: string }
    | { type: "settings"; device: string; zoom: number | null; logs: boolean }
    | { type: "crash"; text: string }
    | { type: "refresh" }
    | { type: "reportIssue" }
    | { type: "files"; id: number; folders: string; files: string }
    | { type: "resources"; id: number; folder: string }
    | { type: "resource"; id: number; folder: string; path: string }
    | { type: "image"; id: number; url: string };

export const VIEW_TYPE = "fastCompose.preview";
const DEVICE_KEY = "fastCompose.preview.device";
const ZOOM_KEY = "fastCompose.preview.zoom";
const LOGS_KEY = "fastCompose.preview.logs";

/**
 * The preview beside the editor: a webview running Fast Compose's Wasm build from `dist/webview`. Follows the active
 * Kotlin editor and sends its unsaved text on every change. Another file's editor clears the preview, so it never shows
 * a previous file's previews; focusing the preview itself or a panel keeps it. The webview reads other workspace files
 * and resources through this panel.
 *
 * Nothing is sent while the preview is hidden: edits and file changes are only noted, and applied when it is shown
 * again. After a crash the webview is reloaded and shows the crash in its logs without rendering previews, until the
 * file is edited, Refresh is pressed or another file is shown; if it crashes again, plain text replaces it.
 */
export class PreviewPanel {
    private static current: PreviewPanel | undefined;

    /** The Fast Compose version the webview last reported; for issue reports. */
    static engineVersion: string | undefined;

    private static imageCache: ImageCache | undefined;

    /** Network images, cached in the extension's storage folder; kept in memory while the preview is open. */
    private static images(context: vscode.ExtensionContext): ImageCache {
        PreviewPanel.imageCache ??= new ImageCache(vscode.Uri.joinPath(context.globalStorageUri, "images"));
        return PreviewPanel.imageCache;
    }

    /** Opens the preview beside the active editor, or reveals it when it is already open; see [lockGroup]. */
    static async show(context: vscode.ExtensionContext): Promise<void> {
        if (PreviewPanel.current) {
            PreviewPanel.current.panel.reveal(undefined, true);
            return;
        }
        const previous = currentEditor();
        const panel = vscode.window.createWebviewPanel(
            VIEW_TYPE,
            "Fast Compose Preview",
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { ...webviewOptions(context), retainContextWhenHidden: true },
        );
        PreviewPanel.current = new PreviewPanel(panel, context);
        await lockGroup(panel, previous);
    }

    /** Shows the preview again in [panel], e.g. after VS Code restarts; see [lockGroup]. */
    static async restore(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): Promise<void> {
        PreviewPanel.current?.panel.dispose();
        panel.webview.options = webviewOptions(context);
        PreviewPanel.current = new PreviewPanel(panel, context);
        await lockGroup(panel, currentEditor());
    }

    /**
     * Opens the preview and scrolls to the preview function [name] of the active file, e.g. from its CodeLens. A new
     * preview scrolls once it shows the file.
     */
    static async reveal(context: vscode.ExtensionContext, name: string): Promise<void> {
        await PreviewPanel.show(context);
        const current = PreviewPanel.current;
        if (!current) return;
        if (current.ready) current.post({ type: "reveal", name });
        else current.pendingReveal = name;
    }

    /** Rebuilds the open preview from scratch: the file, the files it uses and its resources are read again. */
    static refresh(): void {
        const current = PreviewPanel.current;
        if (!current) return;
        current.clearCrash();
        current.showDocument();
        current.post({ type: "reload" });
    }

    /** The followed Kotlin document; undefined when no Kotlin file is previewed. */
    private document: vscode.TextDocument | undefined;

    /** True once the webview listens for messages; nothing is sent before. */
    private ready = false;

    /** True once the panel is closed; nothing is sent after. */
    private disposed = false;

    /** The message of the crash the current webview was loaded for; undefined when it didn't crash. */
    private crash: string | undefined;

    /** True while plain text replaces the webview, after it crashed again while showing a crash. */
    private fallback = false;

    /** True when the followed file or its text changed while the preview was hidden. */
    private staleText = false;

    /** True when workspace files changed while the preview was hidden. */
    private staleFiles = false;

    /** Counts webview loads, so reloading with the same page loads it again. */
    private loads = 0;

    /** The workspace's Gradle modules; see [findModules]. */
    private modules: Promise<Module[]> = findModules();

    /** A preview function to scroll to once the webview is ready; see [reveal]. */
    private pendingReveal: string | undefined;

    private readonly root: vscode.Uri;
    private readonly disposables: vscode.Disposable[] = [];

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext,
    ) {
        this.root = vscode.Uri.joinPath(context.extensionUri, "dist", "webview");
        panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "docs", "images", "logo.png");
        this.load();
        this.disposables.push(
            panel.webview.onDidReceiveMessage((message: WebviewMessage) => this.receive(message)),
            panel.onDidChangeViewState(() => this.visibilityChanged()),
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (editor) this.follow(editor.document);
            }),
            // Editors restored at startup may appear after the preview, while it has focus.
            vscode.window.onDidChangeVisibleTextEditors(() => {
                if (!this.document && !vscode.window.activeTextEditor) this.follow(currentEditor()?.document);
            }),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.document !== this.document) return;
                this.clearCrash();
                this.showDocument();
            }),
            vscode.workspace.onDidCloseTextDocument((closed) => {
                if (closed === this.document) this.follow(undefined);
            }),
            new FileChanges(
                (paths, structure) => this.filesChanged(paths, structure),
                () => this.modulesChanged(),
            ),
            panel.onDidDispose(() => this.dispose()),
        );
    }

    private receive(message: WebviewMessage): void {
        switch (message.type) {
            case "ready":
                this.started(message.engineVersion);
                break;
            case "open":
                this.open(message.path, message.line);
                break;
            case "copy":
                vscode.env.clipboard.writeText(message.text);
                break;
            case "refresh":
                vscode.commands.executeCommand("fastCompose.refreshPreview");
                break;
            case "reportIssue":
                vscode.commands.executeCommand("fastCompose.reportIssue");
                break;
            case "settings":
                this.context.workspaceState.update(DEVICE_KEY, message.device);
                this.context.workspaceState.update(ZOOM_KEY, message.zoom ?? undefined);
                this.context.workspaceState.update(LOGS_KEY, message.logs);
                break;
            case "crash":
                this.crashed(message.text);
                break;
            case "files":
                this.reply(message.id, readFiles(lines(message.folders), lines(message.files)));
                break;
            case "resources":
                this.reply(message.id, listResources(message.folder));
                break;
            case "resource":
                this.reply(message.id, readResource(message.folder, message.path));
                break;
            case "image":
                this.reply(message.id, PreviewPanel.images(this.context).get(message.url));
                break;
        }
    }

    /**
     * Sends a newly loaded webview the settings, the crash it was loaded for, the modules, the followed file and the
     * preview to scroll to.
     */
    private async started(engineVersion: string): Promise<void> {
        this.ready = true;
        PreviewPanel.engineVersion = engineVersion;
        this.post({
            type: "settings",
            device: this.context.workspaceState.get<string>(DEVICE_KEY) ?? null,
            zoom: this.context.workspaceState.get<number>(ZOOM_KEY) ?? null,
            logs: this.context.workspaceState.get<boolean>(LOGS_KEY) ?? false,
        });
        if (this.crash !== undefined) this.post({ type: "crash", text: this.crash });
        this.post({ type: "modules", paths: modulesText(await this.modules) });
        this.follow(this.document ?? currentEditor()?.document);
        if (this.pendingReveal) this.post({ type: "reveal", name: this.pendingReveal });
        this.pendingReveal = undefined;
    }

    /**
     * Previews [document] when it is a Kotlin file, and clears the preview for any other file or none. Documents that
     * are not files, such as the output panel, are ignored.
     */
    private follow(document: vscode.TextDocument | undefined): void {
        if (document && document.uri.scheme !== "file" && document.uri.scheme !== "untitled") return;
        if (document !== this.document) this.clearCrash();
        if (document && document.uri.path.endsWith(".kt")) {
            this.document = document;
            this.showDocument();
        } else {
            this.document = undefined;
            this.staleText = false;
            this.post({ type: "clear" });
        }
    }

    /** Sends the followed document's text, or notes it for when the preview is shown again. */
    private showDocument(): void {
        const document = this.document;
        if (!document) return;
        if (!this.panel.visible) {
            this.staleText = true;
            return;
        }
        this.post({ type: "show", path: pathOf(document.uri), text: document.getText() });
    }

    private filesChanged(paths: string[], structure: boolean): void {
        if (!this.panel.visible) {
            this.staleFiles = true;
            return;
        }
        this.post({ type: "changed", paths: paths.join("\n"), structure });
    }

    /** Finds the modules again and sends them; the webview then reads other files and resources again. */
    private async modulesChanged(): Promise<void> {
        this.modules = findModules();
        const modules = await this.modules;
        if (!this.panel.visible) {
            this.staleFiles = true;
            return;
        }
        this.post({ type: "modules", paths: modulesText(modules) });
    }

    /**
     * Applies what changed while the preview was hidden, once it is shown again: after file changes, the modules are
     * sent again, so the webview reads other files and resources again.
     */
    private async visibilityChanged(): Promise<void> {
        if (!this.panel.visible) return;
        if (this.staleFiles) {
            this.staleFiles = false;
            this.post({ type: "modules", paths: modulesText(await this.modules) });
        }
        if (this.staleText) {
            this.staleText = false;
            this.showDocument();
        }
    }

    /**
     * Handles an uncaught error in the webview. The failed composition can't be trusted, so the webview is loaded
     * again and shows the crash in its logs without rendering previews. If it crashes again, plain text replaces it.
     */
    private crashed(text: string): void {
        if (this.fallback) return;
        if (this.crash !== undefined) {
            this.fallback = true;
            this.ready = false;
            this.panel.webview.html = crashPage(text);
            return;
        }
        this.crash = text;
        this.load();
    }

    /** Leaves crash mode, e.g. after an edit or refresh; previews render again, in a new webview if text was shown. */
    private clearCrash(): void {
        if (this.crash === undefined) return;
        this.crash = undefined;
        if (this.fallback) {
            this.fallback = false;
            this.load();
        } else {
            this.post({ type: "crash", text: null });
        }
    }

    /** Opens [path] (the previewed file when null) at 1-based [line], in the editor group it is shown in, if any. */
    private async open(path: string | null, line: number): Promise<void> {
        const uri = path ? vscode.Uri.file(path) : this.document?.uri;
        if (!uri) return;
        const target = uri.toString();
        const shown = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === target);
        const position = new vscode.Position(Math.max(line - 1, 0), 0);
        await vscode.window.showTextDocument(uri, {
            viewColumn: shown?.viewColumn ?? vscode.ViewColumn.One,
            selection: new vscode.Range(position, position),
        });
    }

    /** Answers the webview's request [id] with [body] once it is read. */
    private async reply(id: number, body: Promise<unknown>): Promise<void> {
        this.post({ type: "reply", id, body: await body.catch(() => null) });
    }

    /** Sends [message] to the webview once it is ready; nothing after the panel closed, e.g. a late reply. */
    private post(message: object): void {
        if (this.ready && !this.disposed) this.panel.webview.postMessage(message);
    }

    /** Loads the webview's page, again when it is already loaded. */
    private load(): void {
        this.ready = false;
        this.loads++;
        this.panel.webview.html = this.html();
    }

    /**
     * The webview's page: loads `fast-compose-preview.js`, which loads its `.wasm` files from the same folder and may
     * start workers from blob URLs. Images and Compose's fallback fonts may come from any https address.
     */
    private html(): string {
        const webview = this.panel.webview;
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.root, "fast-compose-preview.js"));
        const styles = webview.asWebviewUri(vscode.Uri.joinPath(this.root, "styles.css"));
        const source = webview.cspSource;
        const policy = [
            "default-src 'none'",
            `script-src ${source} 'wasm-unsafe-eval'`,
            // Images are decoded in a worker started from a blob URL.
            `worker-src ${source} blob:`,
            `style-src ${source} 'unsafe-inline'`,
            `img-src ${source} https: data: blob:`,
            `font-src ${source} https: data:`,
            `connect-src ${source} https:`,
        ].join("; ");
        return `<!DOCTYPE html>
<html lang="en" data-load="${this.loads}">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${policy}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${styles}">
</head>
<body>
<div id="preview"></div>
<script src="${script}"></script>
</body>
</html>`;
    }

    private dispose(): void {
        this.disposed = true;
        if (PreviewPanel.current === this) {
            PreviewPanel.current = undefined;
            PreviewPanel.imageCache = undefined;
        }
        this.disposables.forEach((disposable) => disposable.dispose());
    }
}

/**
 * Locks the editor group holding [panel] when more than one group is open, so files opened while the preview is
 * focused open in another group. VS Code locks only the active group, so the preview is focused for it, then
 * [previous] is focused again.
 */
async function lockGroup(panel: vscode.WebviewPanel, previous: vscode.TextEditor | undefined): Promise<void> {
    if (vscode.window.tabGroups.all.length < 2) return;
    panel.reveal(undefined, false);
    if (await previewGroupActive()) await vscode.commands.executeCommand("workbench.action.lockEditorGroup");
    if (previous) await vscode.window.showTextDocument(previous.document, previous.viewColumn);
}

/** Waits up to a second until the active editor group shows the preview; false when it doesn't. */
function previewGroupActive(): Promise<boolean> {
    const isActive = () => isPreviewTab(vscode.window.tabGroups.activeTabGroup.activeTab);
    if (isActive()) return Promise.resolve(true);
    return new Promise((resolve) => {
        const done = (active: boolean) => {
            listeners.forEach((listener) => listener.dispose());
            clearTimeout(timer);
            resolve(active);
        };
        const check = () => {
            if (isActive()) done(true);
        };
        const groups = vscode.window.tabGroups;
        const listeners = [groups.onDidChangeTabGroups(check), groups.onDidChangeTabs(check)];
        const timer = setTimeout(() => done(false), 1000);
    });
}

/**
 * The active text editor or, while the preview or a panel has focus (e.g. at startup), a visible Kotlin editor or any
 * visible editor.
 */
function currentEditor(): vscode.TextEditor | undefined {
    const visible = vscode.window.visibleTextEditors;
    return (
        vscode.window.activeTextEditor ??
        visible.find((editor) => editor.document.uri.path.endsWith(".kt")) ??
        visible[0]
    );
}

/** True when [tab] shows the preview; webview tabs report their view type with a `mainThreadWebview-` prefix. */
function isPreviewTab(tab: vscode.Tab | undefined): boolean {
    return tab?.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(VIEW_TYPE);
}

/** Options of the preview's webview: scripts on, and files only from `dist/webview`. */
function webviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions {
    return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")] };
}

/** A page with [text], the error the preview crashed with again while showing a crash. */
function crashPage(text: string): string {
    const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'">
</head>
<body>
<p>Preview crashed: ${escaped}</p>
<p>Edit the file or press Refresh to try again.</p>
</body>
</html>`;
}

/** [modules] as the webview reads them: a line per module, its folder then its dependencies' folders, tab-separated. */
function modulesText(modules: Module[]): string {
    return modules.map((module) => [module.folder, ...module.dependencies].join("\t")).join("\n");
}

/** The non-empty lines of [text]. */
function lines(text: string): string[] {
    return text.split("\n").filter((line) => line.length > 0);
}
