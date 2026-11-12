import org.jetbrains.kotlin.gradle.ExperimentalWasmDsl

plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
}

kotlin {
    // The extension's page loads fast-compose-preview.js; the name is fixed so it does not depend on the project path.
    @OptIn(ExperimentalWasmDsl::class)
    wasmJs {
        outputModuleName.set("fast-compose-preview")
        browser {
            commonWebpackConfig {
                outputFileName = "fast-compose-preview.js"
                // Source maps in their own files: the panel's content security policy blocks eval.
                devtool = "source-map"
            }
        }
        binaries.executable()
    }

    sourceSets {
        wasmJsMain.dependencies {
            implementation(libs.fast.compose)
            implementation(libs.compose.ui)
            implementation(libs.compose.foundation)
            implementation(libs.compose.material3)
            implementation(libs.coil)
        }
    }
}

// Copy a build into the extension's dist/webview folder, which the extension's panel loads: installWebview the
// production build, for releases; installDevWebview the development build, which builds faster but is larger.
tasks.register<Sync>("installWebview") {
    from(tasks.named("wasmJsBrowserDistribution"))
    into(layout.projectDirectory.dir("../dist/webview"))
}

tasks.register<Sync>("installDevWebview") {
    from(tasks.named("wasmJsBrowserDevelopmentExecutableDistribution"))
    into(layout.projectDirectory.dir("../dist/webview"))
}
