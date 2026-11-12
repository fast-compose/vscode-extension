package ma7moud3ly.fast.compose.vscode

import ma7moud3ly.fast.compose.interpreter.SourceFile
import ma7moud3ly.fast.compose.interpreter.SourceProvider
import ma7moud3ly.fast.compose.project.GradleLayout
import ma7moud3ly.fast.compose.project.KotlinSources

/** A Gradle module of the workspace: its [folder] and the folders of the project modules it depends on directly. */
internal class Module(val folder: String, val dependencies: List<String>)

/**
 * Workspace Kotlin files for multi-file previews: [provider] finds the file that declares a top-level name in a
 * package and tells project packages from library ones.
 *
 * VS Code has no project model, so the extension reads the modules and their `project(":…")` dependencies from the
 * Gradle build files ([modules]). Lookups read a package's folder under the previewed file's own source root and its
 * module's shared source sets ([KotlinSources.folderRoots]), then under the shared source sets (`commonMain`, `main`)
 * of the modules it depends on, directly or not, then of the others ([visibleModules]). The engine's [KotlinSources]
 * does the lookups over [files], and replaces `expect` declarations by their `actual`.
 */
internal class ProjectSources(private val files: WorkspaceFiles) {

    private val sources = KotlinSources(files)

    /** The workspace's Gradle modules. */
    var modules: List<Module> = emptyList()
        set(value) {
            field = value
            projectPackages.clear()
        }

    /** Answers of [SourceProvider.isProjectPackage] by package; cleared when files are added, removed or moved. */
    private val projectPackages = HashMap<String, Boolean>()

    /** Finds declarations for a preview of the file at [path]. */
    fun provider(path: String): SourceProvider = FileSources(path)

    /** True when [path] is a file previews have looked into, so its changes may affect them. */
    fun isKnown(path: String): Boolean = sources.isKnown(path)

    /** Forgets [paths] after they changed; see [WorkspaceFiles.invalidate]. */
    fun changed(paths: Collection<String>, structure: Boolean) {
        if (structure) {
            paths.forEach(sources::forget)
            projectPackages.clear()
        }
    }

    /** Drops every parsed file and package answer, so the next lookups read everything again. */
    fun clear() {
        sources.clear()
        projectPackages.clear()
    }

    /**
     * Folders of the other modules, in lookup order for the file at [path]: the modules its module depends on, directly
     * or not, nearest first, then the rest, since build files may not list every dependency, e.g. those added by a
     * convention plugin.
     */
    fun visibleModules(path: String): List<String> {
        val own = modules.filter { path.startsWith("${it.folder}/") }.maxByOrNull { it.folder.length }
        val byFolder = modules.associateBy { it.folder }
        val visible = LinkedHashSet<String>()
        val queue = ArrayDeque(own?.dependencies.orEmpty())
        while (queue.isNotEmpty()) {
            val folder = queue.removeFirst()
            if (folder == own?.folder || !visible.add(folder)) continue
            byFolder[folder]?.dependencies?.let(queue::addAll)
        }
        modules.forEach { if (it != own) visible += it.folder }
        return visible.toList()
    }

    private inner class FileSources(private val from: String) : SourceProvider {

        private val visible = visibleModules(from)

        override suspend fun find(packageName: String, name: String): SourceFile? =
            files.load { sources.find(packageName, name, roots(), from) }

        /**
         * True when [packageName] has a folder under a source root of the previewed file's module or a module it sees,
         * or next to the previewed file. Other packages are libraries, which the engine never looks up or reports.
         */
        override suspend fun isProjectPackage(packageName: String): Boolean {
            if (packageName.isEmpty()) return true
            projectPackages[packageName]?.let { return it }
            val isProject = files.load {
                sources.hasPackage(packageName, roots()) ||
                    sources.hasPackage(packageName, listOfNotNull(sources.sourceRootOf(from)))
            }
            projectPackages[packageName] = isProject
            return isProject
        }

        override suspend fun findExpect(packageName: String, name: String): SourceFile? =
            files.load { sources.findExpect(packageName, name, roots(), from) }

        /** The previewed file's own roots first, then the shared source roots of the modules it sees that exist. */
        private fun roots(): List<String> {
            val others = visible.flatMap { module ->
                GradleLayout.SHARED_SOURCE_SETS.flatMap { sourceSet ->
                    GradleLayout.SOURCE_ROOTS.map { "$module/src/$sourceSet/$it" }
                }
            }
            return (sources.folderRoots(from) + others.filter(files::isFolder)).distinct()
        }
    }
}
