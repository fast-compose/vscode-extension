package ma7moud3ly.fast.compose.vscode

import coil3.ImageLoader
import coil3.SingletonImageLoader
import coil3.Uri
import coil3.decode.DataSource
import coil3.decode.ImageSource
import coil3.fetch.FetchResult
import coil3.fetch.Fetcher
import coil3.fetch.SourceFetchResult
import coil3.request.Options
import coil3.serviceLoaderEnabled
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import okio.Buffer

/**
 * Sets up Coil's singleton `ImageLoader`, used by `AsyncImage` in previews, to download network images through the
 * extension ([HostImageFetcher]). Coil's service loader is off, so its own network fetcher is never used.
 */
internal object ImageLoading {

    /** Installs the image loader; call before showing any preview. */
    fun install() {
        SingletonImageLoader.setSafe { context ->
            ImageLoader.Builder(context)
                .serviceLoaderEnabled(false)
                .components { add(HostImageFetcher.Factory()) }
                .build()
        }
    }
}

/**
 * Downloads an `http` or `https` image through the extension. The webview's own requests are refused by servers that
 * don't send CORS headers, which many image hosts don't.
 */
private class HostImageFetcher(private val url: String, private val options: Options) : Fetcher {

    @OptIn(ExperimentalEncodingApi::class)
    override suspend fun fetch(): FetchResult {
        val image = requestImage(url) ?: error("Couldn't download $url")
        return SourceFetchResult(
            source = ImageSource(Buffer().write(Base64.decode(image.data)), options.fileSystem),
            mimeType = image.type,
            dataSource = DataSource.NETWORK,
        )
    }

    class Factory : Fetcher.Factory<Uri> {
        override fun create(data: Uri, options: Options, imageLoader: ImageLoader): Fetcher? =
            if (data.scheme == "http" || data.scheme == "https") HostImageFetcher(data.toString(), options) else null
    }
}
