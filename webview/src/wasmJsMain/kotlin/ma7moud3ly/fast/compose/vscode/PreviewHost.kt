package ma7moud3ly.fast.compose.vscode

import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import ma7moud3ly.fast.compose.bindings.resources.ResourceProvider
import ma7moud3ly.fast.compose.parser.KotlinParser

/**
 * Applies the extension's messages to [state], and sends device, zoom and logs changes back to be saved.
 *
 * Nothing is prepared for a file until it is known to have a `@Preview` annotation: the check runs at once when the
 * file is shown and after a pause in typing when it is edited, and only then are its other files and resources looked
 * up and the preview rendered.
 */
internal class PreviewHost(private val state: PreviewState) {

    private val scope = MainScope()
    private val files = WorkspaceFiles()
    private val sources = ProjectSources(files)
    private val resources = ProjectResources(files, scope)
    private var detectJob: Job? = null
    private var resourcesJob: Job? = null

    /** Path of the file whose other files and resources are prepared, after it was found to have a `@Preview`. */
    private var preparedPath: String? = null

    init {
        onHostMessage(::receive)
        scope.launch {
            snapshotFlow { Triple(state.device, state.zoom, state.showLogs) }.drop(1).collect { (device, zoom, logs) ->
                postSettings(device.name, zoom, logs)
            }
        }
    }

    private fun receive(message: HostMessage) {
        when (message.type) {
            "show" -> show(message.path ?: return, message.text.orEmpty())
            "clear" -> {
                detectJob?.cancel()
                unprepare()
                state.clear()
            }

            "reload" -> reload()
            "crash" -> state.crash = message.text
            "settings" -> {
                state.device = PreviewDevice.entries.find { it.name == message.device } ?: PreviewDevice.Phone
                state.zoom = message.zoom?.toDouble()?.toFloat()
                state.showLogs = message.logs?.toBoolean() == true
            }

            "modules" -> {
                sources.modules = message.paths.orEmpty().lines().filter { it.isNotEmpty() }.map { line ->
                    val folders = line.split('\t')
                    Module(folders.first(), folders.drop(1))
                }
                reload()
            }

            "reveal" -> state.reveal = message.name?.let(::Reveal)

            "changed" -> changed(
                message.paths.orEmpty().lines().filter { it.isNotEmpty() },
                message.structure?.toBoolean() == true,
            )
        }
    }

    /** Shows [text] of [path]; another file is checked for `@Preview` at once, an edit after [TYPING_DELAY_MS]. */
    private fun show(path: String, text: String) {
        val isEdit = path == state.path
        if (!isEdit) unprepare()
        // The file's own package and folder are read from it too, e.g. to find its source root.
        files.invalidate(listOf(path), structure = false)
        state.show(path, text)
        detect(if (isEdit) TYPING_DELAY_MS else 0)
    }

    /** Checks the shown text for a `@Preview` annotation after [delayMs]; only with one is the preview rendered. */
    private fun detect(delayMs: Long) {
        val path = state.path ?: return
        val text = state.text
        detectJob?.cancel()
        detectJob = scope.launch {
            delay(delayMs)
            if (state.path != path) return@launch
            val hasPreviews = KotlinParser.hasPreviews(text)
            if (hasPreviews) prepare(path) else unprepare()
            state.hasPreviews = hasPreviews
        }
    }

    /** Prepares [path]'s other files and resources, once per file. */
    private fun prepare(path: String) {
        if (path == preparedPath) return
        preparedPath = path
        state.sources = sources.provider(path)
        loadResources(path)
    }

    /** Drops what [prepare] set up, e.g. when the file loses its last `@Preview` or another file is shown. */
    private fun unprepare() {
        if (preparedPath == null) return
        preparedPath = null
        resourcesJob?.cancel()
        state.sources = null
        state.resources = ResourceProvider.Empty
    }

    private fun loadResources(path: String) {
        resourcesJob?.cancel()
        resourcesJob = scope.launch { state.resources = resources.provider(path, sources.visibleModules(path)) }
    }

    /**
     * Applies changes to workspace files: changed resources are read again, and the preview is rebuilt when a file it
     * used changed, or files were added, removed or moved ([structure]), so classes and values declared outside
     * composables are read again too.
     */
    private fun changed(paths: List<String>, structure: Boolean) {
        files.invalidate(paths, structure)
        sources.changed(paths, structure)
        resources.changed(paths)
        val path = preparedPath ?: return
        if (structure) loadResources(path)
        if (structure || paths.any { it != path && sources.isKnown(it) }) state.rebuild()
    }

    /** Rebuilds the preview from scratch: the files it uses and its resources are read again. */
    private fun reload() {
        files.clear()
        sources.clear()
        resources.refresh()
        val path = preparedPath ?: return
        state.sources = sources.provider(path)
        loadResources(path)
        state.rebuild()
    }

    private companion object {
        const val TYPING_DELAY_MS = 150L
    }
}
