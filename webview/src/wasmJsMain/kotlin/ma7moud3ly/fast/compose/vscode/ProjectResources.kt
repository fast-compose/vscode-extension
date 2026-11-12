package ma7moud3ly.fast.compose.vscode

import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import ma7moud3ly.fast.compose.bindings.resources.ChainResources
import ma7moud3ly.fast.compose.bindings.resources.ResourceProvider
import ma7moud3ly.fast.compose.bindings.resources.ResourceStorage
import ma7moud3ly.fast.compose.bindings.resources.StorageResources
import ma7moud3ly.fast.compose.bindings.resources.StoredFile
import ma7moud3ly.fast.compose.project.GradleLayout

/**
 * Resources for the previewed file: one [StorageResources] per resource folder, chained most specific first. Folders
 * come from the engine's Gradle layout rules ([GradleLayout.resourceFolders]): the file's own source set, then the
 * shared source sets of the modules it sees ([ProjectSources.visibleModules]), then its module's shared source sets.
 * Folders are kept while the previewed file moves between files that use them, so cached files are reused.
 */
internal class ProjectResources(private val files: WorkspaceFiles, private val scope: CoroutineScope) {

    /** Providers of the current file's resource folders by path. */
    private var folders = HashMap<String, StorageResources>()

    /** Resources for the file at [path], with [modules] the folders of the modules it sees. */
    suspend fun provider(path: String, modules: List<String>): ResourceProvider {
        val sourceSets = modules.flatMap { module -> GradleLayout.SHARED_SOURCE_SETS.map { "$module/src/$it" } }
        val roots = files.load { GradleLayout.resourceFolders(files, path, sourceSets) }
        val previous = folders
        folders = HashMap()
        roots.forEach { root ->
            folders[root] = previous[root] ?: StorageResources(HostStorage(root), scope, CACHE_BYTES)
        }
        return if (roots.isEmpty()) ResourceProvider.Empty else ChainResources(roots.map(folders::getValue))
    }

    /** Lists the folders holding [paths] again, so changed files are read again when previews need them. */
    fun changed(paths: Collection<String>) {
        folders.filterKeys { folder -> paths.any { it.startsWith("$folder/") } }.values.forEach {
            scope.launch { it.refresh() }
        }
    }

    /** Lists every folder again. */
    fun refresh() {
        folders.values.forEach { scope.launch { it.refresh() } }
    }

    /** A resource folder read through the extension; open files with unsaved edits, such as `strings.xml`, included. */
    private class HostStorage(private val folder: String) : ResourceStorage {

        override suspend fun list(): List<StoredFile> {
            val listed = requestResources(folder) ?: return emptyList()
            return (0 until listed.length).mapNotNull { listed[it] }.map { StoredFile(it.path, it.version.toLong()) }
        }

        @OptIn(ExperimentalEncodingApi::class)
        override suspend fun read(path: String): ByteArray? = requestResource(folder, path)?.let { Base64.decode(it) }
    }

    private companion object {
        const val CACHE_BYTES = 16L * 1024 * 1024
    }
}
