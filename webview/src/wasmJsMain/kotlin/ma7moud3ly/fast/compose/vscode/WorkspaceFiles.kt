package ma7moud3ly.fast.compose.vscode

import ma7moud3ly.fast.compose.project.FileEntry
import ma7moud3ly.fast.compose.project.ProjectFiles

/**
 * The workspace's folders and files as far as previews read them, fetched from the extension and kept until it reports
 * them changed. Unsaved editor text is used.
 *
 * The engine reads [ProjectFiles] synchronously, while the extension answers asynchronously, so reads run in [load]:
 * the reader runs over what is cached, and whatever it missed is fetched in one request before it runs again.
 */
internal class WorkspaceFiles : ProjectFiles {

    /** Folder entries by path; null for paths that are not folders. */
    private val folders = HashMap<String, List<FileEntry>?>()

    /** File texts by path; null for files that can't be read. */
    private val texts = HashMap<String, String?>()

    /** Versions of [texts]; each fetched text gets a new one. */
    private val versions = HashMap<String, Long>()
    private var nextVersion = 0L

    private val missingFolders = LinkedHashSet<String>()
    private val missingFiles = LinkedHashSet<String>()

    override fun list(path: String): List<FileEntry> {
        if (path !in folders) missingFolders += path
        return folders[path].orEmpty()
    }

    override fun isFolder(path: String): Boolean {
        if (path !in folders) missingFolders += path
        return folders[path] != null
    }

    override fun read(path: String): String? {
        if (path !in texts) missingFiles += path
        return texts[path]
    }

    override fun version(path: String): Long {
        if (path !in versions) missingFiles += path
        return versions[path] ?: -1L
    }

    /**
     * Runs [reader] until it reads only cached folders and files, fetching what it missed between runs, at most
     * [MAX_ROUNDS] times. Each run must only read; its result is kept from the last run.
     */
    suspend fun <T> load(reader: () -> T): T {
        repeat(MAX_ROUNDS) {
            missingFolders.clear()
            missingFiles.clear()
            val result = reader()
            if (missingFolders.isEmpty() && missingFiles.isEmpty()) return result
            val reply = requestFiles(missingFolders.toList(), missingFiles.toList()) ?: return result
            for (i in 0 until reply.folders.length) {
                val folder = reply.folders[i] ?: continue
                folders[folder.path] = folder.entries?.let { entries ->
                    (0 until entries.length).mapNotNull { entries[it] }.map {
                        FileEntry(it.name, it.isFolder, it.size.toLong())
                    }
                }
            }
            for (i in 0 until reply.files.length) {
                val file = reply.files[i] ?: continue
                texts[file.path] = file.text
                versions[file.path] = nextVersion++
            }
        }
        return reader()
    }

    /**
     * Drops [paths] so they are read again. When files were added, removed or moved ([structure]), every folder listing
     * is dropped too.
     */
    fun invalidate(paths: Collection<String>, structure: Boolean) {
        paths.forEach {
            texts -= it
            versions -= it
        }
        if (structure) folders.clear()
    }

    /** Drops every folder and file. */
    fun clear() {
        folders.clear()
        texts.clear()
        versions.clear()
    }

    private companion object {
        const val MAX_ROUNDS = 12
    }
}
