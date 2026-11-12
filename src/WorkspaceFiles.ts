import * as vscode from "vscode";

/** A folder entry as the webview reads it; see `webview/.../WorkspaceFiles.kt`. */
interface Entry {
    name: string;
    isFolder: boolean;
    size: number;
}

/** Resource subfolders previews use, e.g. `drawable-night`, `values-ar`, `font` or `files`. */
const RESOURCE_TYPES = /^(drawable|mipmap|values|font|files)(-|$)/;
const MAX_RESOURCE_BYTES = 20 * 1024 * 1024;

/** Paths inside a resource folder. */
const RESOURCE_PATH = /\/(res|composeResources)\//;

/** [uri]'s path with `/` separators, as the engine expects. */
export function pathOf(uri: vscode.Uri): string {
    return uri.scheme === "file" ? uri.fsPath.replace(/\\/g, "/") : uri.path;
}

/** The open document at [path], which may have unsaved edits. */
function openDocument(path: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((document) => pathOf(document.uri) === path);
}

/** Lists [folders] and reads [files] for the webview; open files give their unsaved text. */
export async function readFiles(folders: string[], files: string[]): Promise<object> {
    return {
        folders: await Promise.all(folders.map(async (path) => ({ path, entries: await listFolder(path) }))),
        files: await Promise.all(files.map(async (path) => ({ path, text: await readText(path) }))),
    };
}

/** Entries of folder [path]; null when it is missing or not a folder. Sizes are read for Kotlin files only. */
async function listFolder(path: string): Promise<Entry[] | null> {
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path));
    } catch {
        return null;
    }
    return Promise.all(
        entries.map(async ([name, type]) => {
            const isFolder = (type & vscode.FileType.Directory) !== 0;
            const size = !isFolder && name.endsWith(".kt") ? await sizeOf(`${path}/${name}`) : 0;
            return { name, isFolder, size };
        }),
    );
}

async function sizeOf(path: string): Promise<number> {
    try {
        return (await vscode.workspace.fs.stat(vscode.Uri.file(path))).size;
    } catch {
        return 0;
    }
}

async function readText(path: string): Promise<string | null> {
    const document = openDocument(path);
    if (document) return document.getText();
    try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(path)));
    } catch {
        return null;
    }
}

/**
 * Files of resource [folder] in the subfolders previews use, relative to it (e.g. `drawable/logo.png`), with versions
 * that change on every save or unsaved edit. Hidden files and files over 20 MB are skipped; null when the folder can't
 * be listed.
 */
export async function listResources(folder: string): Promise<{ path: string; version: number }[] | null> {
    let subfolders: [string, vscode.FileType][];
    try {
        subfolders = await vscode.workspace.fs.readDirectory(vscode.Uri.file(folder));
    } catch {
        return null;
    }
    const listed: { path: string; version: number }[] = [];
    const types = subfolders.filter(([name, type]) => type & vscode.FileType.Directory && RESOURCE_TYPES.test(name));
    await Promise.all(
        types.map(async ([type]) => {
            let files: [string, vscode.FileType][];
            try {
                files = await vscode.workspace.fs.readDirectory(vscode.Uri.file(`${folder}/${type}`));
            } catch {
                return;
            }
            const visible = files.filter(([name, kind]) => kind & vscode.FileType.File && !name.startsWith("."));
            await Promise.all(
                visible.map(async ([name]) => {
                    const path = `${folder}/${type}/${name}`;
                    try {
                        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(path));
                        if (stat.size > MAX_RESOURCE_BYTES) return;
                        listed.push({ path: `${type}/${name}`, version: versionOf(path, stat.mtime) });
                    } catch {
                        // Deleted while listing.
                    }
                }),
            );
        }),
    );
    return listed;
}

/** A version of [path] that changes when it is saved ([mtime]) or, for an open file, on every unsaved edit. */
function versionOf(path: string, mtime: number): number {
    const document = openDocument(path);
    return document?.isDirty ? -document.version : mtime;
}

/** The bytes of [path] in resource [folder] as Base64, unsaved edits included; null when it can't be read. */
export async function readResource(folder: string, path: string): Promise<string | null> {
    const full = `${folder}/${path}`;
    const document = openDocument(full);
    if (document?.isDirty) return Buffer.from(document.getText()).toString("base64");
    try {
        return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(full))).toString("base64");
    } catch {
        return null;
    }
}

/**
 * Reports changed Kotlin and resource files, saved or unsaved, to [onChange] 300 ms after the last change, and saved,
 * added or removed Gradle build and settings files to [onModulesChange].
 */
export class FileChanges implements vscode.Disposable {
    private readonly paths = new Set<string>();
    private structure = false;
    private timer: NodeJS.Timeout | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly onChange: (paths: string[], structure: boolean) => void,
        onModulesChange: () => void,
    ) {
        for (const pattern of ["**/*.kt", "**/{res,composeResources}/**"]) {
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            watcher.onDidChange((uri) => this.note(uri, false));
            watcher.onDidCreate((uri) => this.note(uri, true));
            watcher.onDidDelete((uri) => this.note(uri, true));
            this.disposables.push(watcher);
        }
        const builds = vscode.workspace.createFileSystemWatcher("**/{build,settings}.gradle{,.kts}");
        builds.onDidChange(onModulesChange);
        builds.onDidCreate(onModulesChange);
        builds.onDidDelete(onModulesChange);
        this.disposables.push(
            builds,
            vscode.workspace.onDidChangeTextDocument((event) => {
                const path = pathOf(event.document.uri);
                if (path.endsWith(".kt") || RESOURCE_PATH.test(path)) this.note(event.document.uri, false);
            }),
        );
    }

    private note(uri: vscode.Uri, structure: boolean): void {
        this.paths.add(pathOf(uri));
        this.structure ||= structure;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            const paths = [...this.paths];
            const changedStructure = this.structure;
            this.paths.clear();
            this.structure = false;
            this.onChange(paths, changedStructure);
        }, 300);
    }

    dispose(): void {
        clearTimeout(this.timer);
        this.disposables.forEach((disposable) => disposable.dispose());
    }
}
