import * as crypto from "crypto";
import * as vscode from "vscode";

/** A downloaded image: its bytes as Base64 and its media type, e.g. `image/png`. */
type Image = { data: string; type: string | null };

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DISK_CACHE_BYTES = 100 * 1024 * 1024;
const MEMORY_CACHE_IMAGES = 200;

/**
 * Network images for the webview, whose own requests are refused by servers without CORS headers. Downloads are kept
 * in memory for the session (the last 200) and on disk in [folder] (up to 100 MB, oldest dropped first when the
 * extension starts), and requests for the same image while it downloads share one download.
 */
export class ImageCache {
    private readonly memory = new Map<string, Promise<Image | null>>();

    constructor(private readonly folder: vscode.Uri) {
        vscode.workspace.fs.createDirectory(folder).then(() => this.prune(), () => undefined);
    }

    /** The image at [url]; null when it can't be downloaded, isn't `http` or `https`, or is over 20 MB. */
    get(url: string): Promise<Image | null> {
        const cached = this.memory.get(url);
        if (cached) {
            // Most recently used last.
            this.memory.delete(url);
            this.memory.set(url, cached);
            return cached;
        }
        const image = this.load(url);
        this.memory.set(url, image);
        image.then((loaded) => {
            if (!loaded) this.memory.delete(url);
        });
        if (this.memory.size > MEMORY_CACHE_IMAGES) this.memory.delete(this.memory.keys().next().value!);
        return image;
    }

    /** Reads [url] from the disk cache, or downloads it and stores it there. */
    private async load(url: string): Promise<Image | null> {
        if (!/^https?:\/\//i.test(url)) return null;
        const file = vscode.Uri.joinPath(this.folder, crypto.createHash("sha256").update(url).digest("hex"));
        try {
            const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
            const newline = text.indexOf("\n");
            return { type: text.slice(0, newline) || null, data: text.slice(newline + 1) };
        } catch {
            // Not cached yet.
        }
        const image = await download(url);
        if (image) {
            vscode.workspace.fs
                .writeFile(file, new TextEncoder().encode(`${image.type ?? ""}\n${image.data}`))
                .then(undefined, () => undefined);
        }
        return image;
    }

    /** Deletes the oldest cached files until the disk cache is within 100 MB. */
    private async prune(): Promise<void> {
        try {
            const names = await vscode.workspace.fs.readDirectory(this.folder);
            const files = await Promise.all(
                names.map(async ([name]) => {
                    const uri = vscode.Uri.joinPath(this.folder, name);
                    return { uri, stat: await vscode.workspace.fs.stat(uri) };
                }),
            );
            let total = files.reduce((sum, file) => sum + file.stat.size, 0);
            for (const file of files.sort((a, b) => a.stat.mtime - b.stat.mtime)) {
                if (total <= DISK_CACHE_BYTES) break;
                await vscode.workspace.fs.delete(file.uri);
                total -= file.stat.size;
            }
        } catch {
            // No cache folder yet.
        }
    }
}

async function download(url: string): Promise<Image | null> {
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_IMAGE_BYTES) return null;
        const type = response.headers.get("content-type")?.split(";")[0].trim() || null;
        return { data: bytes.toString("base64"), type };
    } catch {
        return null;
    }
}
