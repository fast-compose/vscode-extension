import * as path from "path";
import * as vscode from "vscode";
import { pathOf } from "./WorkspaceFiles";

/** A Gradle module of the workspace: its folder and the folders of the project modules it depends on directly. */
export interface Module {
    folder: string;
    dependencies: string[];
}

const EXCLUDED = "**/{node_modules,build,.gradle}/**";

/** `include(":app", ":core:ui")` in Kotlin, or `include ':app', ':core:ui'` in Groovy. */
const INCLUDE = /\binclude\s*\(?((?:\s*["'][^"']+["']\s*,?)+)\)?/g;

/** `project(":core").projectDir = file("libs/core")`. */
const PROJECT_DIR = /project\(\s*["'](:[^"']*)["']\s*\)\.projectDir\s*=\s*(?:file|File)\(\s*["']([^"']+)["']/g;

/** `project(":core:ui")` or `project(path = ":core:ui")` in a build file. */
const PROJECT_DEPENDENCY = /\bproject\(\s*(?:path\s*=\s*)?["'](:[^"']*)["']/g;

/** `projects.core.ui`, Gradle's type-safe project accessors. */
const PROJECT_ACCESSOR = /\bprojects((?:\.[A-Za-z_][\w]*)+)/g;

/**
 * The workspace's Gradle modules: folders with a `build.gradle` or `build.gradle.kts` file, outside build outputs.
 * Dependencies are the `project(":…")` and `projects.…` references of each build file, matched to module folders
 * through the `include` and `projectDir` lines of the settings files.
 */
export async function findModules(): Promise<Module[]> {
    const [builds, settings] = await Promise.all([
        vscode.workspace.findFiles("**/build.gradle{,.kts}", EXCLUDED),
        vscode.workspace.findFiles("**/settings.gradle{,.kts}", EXCLUDED),
    ]);
    const folders = new Set(builds.map((uri) => folderOf(pathOf(uri))));
    const byGradlePath = new Map<string, string>();
    for (const uri of settings) {
        const root = folderOf(pathOf(uri));
        const text = await readText(uri);
        for (const match of text.matchAll(INCLUDE)) {
            for (const [, gradlePath] of match[1].matchAll(/["']([^"']+)["']/g)) {
                const relative = gradlePath.replace(/^:/, "").replace(/:/g, "/");
                byGradlePath.set(key(gradlePath), `${root}/${relative}`);
            }
        }
        for (const [, gradlePath, dir] of text.matchAll(PROJECT_DIR)) {
            byGradlePath.set(key(gradlePath), path.posix.normalize(`${root}/${dir.replace(/\\/g, "/")}`));
        }
    }
    const modules: Module[] = [];
    for (const uri of builds) {
        const folder = folderOf(pathOf(uri));
        const text = await readText(uri);
        const references = [
            ...[...text.matchAll(PROJECT_DEPENDENCY)].map((match) => match[1]),
            ...[...text.matchAll(PROJECT_ACCESSOR)].map((match) => match[1].replace(/\./g, ":")),
        ];
        const dependencies = references
            .map((reference) => byGradlePath.get(key(reference)))
            .filter((found): found is string => !!found && found !== folder && folders.has(found));
        modules.push({ folder, dependencies: [...new Set(dependencies)] });
    }
    return modules.sort((a, b) => a.folder.localeCompare(b.folder));
}

/** [gradlePath] compared loosely, so `:feature-main` matches the accessor `projects.featureMain`. */
function key(gradlePath: string): string {
    return gradlePath.toLowerCase().replace(/[^a-z0-9:]/g, "");
}

function folderOf(file: string): string {
    return file.replace(/\/[^/]*$/, "");
}

async function readText(uri: vscode.Uri): Promise<string> {
    try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
        return "";
    }
}
