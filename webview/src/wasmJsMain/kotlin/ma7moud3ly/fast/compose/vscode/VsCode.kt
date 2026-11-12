package ma7moud3ly.fast.compose.vscode

import kotlinx.coroutines.CompletableDeferred

/** A message from the extension; see `src/PreviewPanel.ts`. */
internal external interface HostMessage : JsAny {
    /** `show`, `clear`, `reload`, `settings`, `crash`, `modules`, `changed`, `reveal` or `reply`. */
    val type: String

    /** The preview function to scroll to (`reveal`). */
    val name: String?

    /** The previewed file's path, with `/` separators (`show`). */
    val path: String?

    /** The previewed file's text, unsaved edits included (`show`), or the crash message (`crash`). */
    val text: String?

    /** A [PreviewDevice] name (`settings`). */
    val device: String?

    /** The previews' scale, or null for Fit (`settings`). */
    val zoom: JsNumber?

    /** Whether the logs are shown (`settings`). */
    val logs: JsBoolean?

    /**
     * Lines separated by `\n`: changed files (`changed`), or modules (`modules`), each a module folder followed by the
     * folders of the modules it depends on, separated by tabs.
     */
    val paths: String?

    /** True when files were added, removed or moved, not only edited (`changed`). */
    val structure: JsBoolean?

    /** The request a reply answers (`reply`). */
    val id: JsNumber?

    /** The reply's content (`reply`). */
    val body: JsAny?
}

/** Folders and files the extension read for [requestFiles]. */
internal external interface FilesReply : JsAny {
    val folders: JsArray<FolderReply>
    val files: JsArray<FileReply>
}

/** A folder's entries, or null [entries] when it is not a folder. */
internal external interface FolderReply : JsAny {
    val path: String
    val entries: JsArray<EntryReply>?
}

internal external interface EntryReply : JsAny {
    val name: String
    val isFolder: Boolean
    val size: Double
}

/** A file's text, unsaved edits included, or null [text] when it can't be read. */
internal external interface FileReply : JsAny {
    val path: String
    val text: String?
}

/** A file of a resource folder, relative to it, e.g. `drawable/logo.png`, with a version that changes with it. */
internal external interface StoredFileReply : JsAny {
    val path: String
    val version: Double
}

/** A downloaded image: its bytes as Base64 and its media type, e.g. `image/png`. */
internal external interface ImageReply : JsAny {
    val data: String
    val type: String?
}

/** Calls [action] with every message the extension sends; replies go to their requests. */
internal fun onHostMessage(action: (HostMessage) -> Unit) {
    listen { message ->
        if (message.type == "reply") {
            val id = message.id?.toInt() ?: return@listen
            replies.remove(id)?.complete(message.body)
        } else {
            action(message)
        }
    }
}

/**
 * Calls [action] with the extension's messages: objects with a `type`. Other window messages, such as the strings
 * kotlinx-coroutines posts to schedule work, are skipped.
 */
private fun listen(action: (HostMessage) -> Unit): Unit = js(
    """window.addEventListener('message', (event) => {
    const data = event.data;
    if (data !== null && typeof data === 'object' && typeof data.type === 'string') action(data);
})"""
)

/** Calls [action] with the message of every uncaught error, e.g. an exception Compose threw while drawing a preview. */
internal fun onUncaughtError(action: (String) -> Unit): Unit = js(
    """{
    // The browser reports ResizeObserver loops as errors; they are harmless.
    const report = (message) => { if (!message.startsWith('ResizeObserver')) action(message); };
    window.addEventListener('error', (event) => report(String(event.error?.message || event.message || 'Error')));
    window.addEventListener('unhandledrejection', (event) => report(String(event.reason?.message || event.reason)));
}"""
)

/**
 * Tells the extension that the webview listens for messages, and which Fast Compose version it runs. Also saves a
 * webview state, so VS Code shows the preview again after a restart.
 */
internal fun postReady(engineVersion: String) {
    saveState()
    post(readyMessage(engineVersion))
}

/** Asks the extension to open [path] (the previewed file when null) at 1-based [line]. */
internal fun postOpen(path: String?, line: Int): Unit = post(openMessage(path, line))

/** Asks the extension to put [text] on the clipboard. */
internal fun postCopy(text: String): Unit = post(copyMessage(text))

/** Sends the device, zoom (null for Fit) and whether the logs are shown, which the extension saves per workspace. */
internal fun postSettings(device: String, zoom: Float?, logs: Boolean): Unit =
    post(settingsMessage(device, zoom?.toDouble()?.toJsNumber(), logs))

/** Tells the extension that the preview crashed with [text]; it reloads the webview. */
internal fun postCrash(text: String): Unit = post(crashMessage(text))

/** Asks the extension to refresh the preview. */
internal fun postRefresh(): Unit = post(refreshMessage())

/** Asks the extension to open a new issue report. */
internal fun postReportIssue(): Unit = post(reportIssueMessage())

/** Lists [folders] and reads [files] through the extension; null when the webview is closing. */
internal suspend fun requestFiles(folders: List<String>, files: List<String>): FilesReply? =
    request { filesRequest(it, folders.joinToString("\n"), files.joinToString("\n")) }?.unsafeCast<FilesReply>()

/** Lists the files of resource [folder], one level of subfolders deep; null when it can't be listed. */
internal suspend fun requestResources(folder: String): JsArray<StoredFileReply>? =
    request { resourcesRequest(it, folder) }?.unsafeCast<JsArray<StoredFileReply>>()

/** The bytes of [path] in resource [folder], as Base64; null when it can't be read. */
internal suspend fun requestResource(folder: String, path: String): String? =
    request { resourceRequest(it, folder, path) }?.unsafeCast<JsString>()?.toString()

/** Downloads the image at [url] through the extension; null when it can't be downloaded. */
internal suspend fun requestImage(url: String): ImageReply? =
    request { imageRequest(it, url) }?.unsafeCast<ImageReply>()

/** Replies awaited from the extension, by request id. */
private val replies = HashMap<Int, CompletableDeferred<JsAny?>>()
private var nextRequest = 0

/** Sends the request [message] builds with a new id, and waits for the extension's reply. */
private suspend fun request(message: (id: Int) -> JsAny): JsAny? {
    val id = nextRequest++
    val reply = CompletableDeferred<JsAny?>()
    replies[id] = reply
    try {
        post(message(id))
        return reply.await()
    } finally {
        replies.remove(id)
    }
}

/** Sends [message] to the extension. */
private fun post(message: JsAny): Unit = postTo(vsCodeApi(), message)

private fun saveState(): Unit = saveStateTo(vsCodeApi())

/** VS Code's webview API. It can be acquired only once, so it is kept in a global. */
private fun vsCodeApi(): JsAny =
    js("globalThis.fastComposeVsCode = globalThis.fastComposeVsCode || acquireVsCodeApi()")

private fun postTo(api: JsAny, message: JsAny): Unit = js("api.postMessage(message)")

private fun saveStateTo(api: JsAny): Unit = js("api.setState({ preview: true })")

private fun readyMessage(engineVersion: String): JsAny = js("({ type: 'ready', engineVersion })")

private fun openMessage(path: String?, line: Int): JsAny = js("({ type: 'open', path, line })")

private fun copyMessage(text: String): JsAny = js("({ type: 'copy', text })")

private fun refreshMessage(): JsAny = js("({ type: 'refresh' })")

private fun reportIssueMessage(): JsAny = js("({ type: 'reportIssue' })")

private fun settingsMessage(device: String, zoom: JsNumber?, logs: Boolean): JsAny =
    js("({ type: 'settings', device, zoom, logs })")

private fun crashMessage(text: String): JsAny = js("({ type: 'crash', text })")

private fun filesRequest(id: Int, folders: String, files: String): JsAny = js("({ type: 'files', id, folders, files })")

private fun resourcesRequest(id: Int, folder: String): JsAny = js("({ type: 'resources', id, folder })")

private fun resourceRequest(id: Int, folder: String, path: String): JsAny =
    js("({ type: 'resource', id, folder, path })")

private fun imageRequest(id: Int, url: String): JsAny = js("({ type: 'image', id, url })")
/** True when VS Code's color theme is dark or dark high contrast. */
internal fun isDarkTheme(): Boolean =
    js("['vscode-dark', 'vscode-high-contrast'].includes(document.body.dataset.vscodeThemeKind)")

/** Calls [action] whenever VS Code's color theme changes. */
internal fun onThemeChange(action: () -> Unit): Unit =
    js("new MutationObserver(() => action()).observe(document.body, { attributeFilter: ['data-vscode-theme-kind'] })")
