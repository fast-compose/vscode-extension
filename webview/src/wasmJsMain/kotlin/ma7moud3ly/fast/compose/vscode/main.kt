package ma7moud3ly.fast.compose.vscode

import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.window.ComposeViewport
import ma7moud3ly.fast.compose.FastComposeInfo

/**
 * Shows the previews of the file the extension sends in the `#preview` element, which fills the webview, and follows
 * VS Code's light or dark theme. An uncaught error, e.g. an exception Compose threw while drawing a preview, is sent to
 * the extension, which reloads the webview.
 */
@OptIn(ExperimentalComposeUiApi::class)
fun main() {
    val state = PreviewState(isDark = isDarkTheme())
    onThemeChange { state.isDark = isDarkTheme() }
    onUncaughtError(::postCrash)
    ImageLoading.install()
    PreviewHost(state)
    ComposeViewport(viewportContainerId = "preview") {
        PreviewContent(state, onOpen = ::postOpen, onCopy = ::postCopy)
    }
    postReady(FastComposeInfo.VERSION)
}
