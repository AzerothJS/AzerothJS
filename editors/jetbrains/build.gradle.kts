// Build with JDK 21 (set JAVA_HOME): `gradle buildPlugin`.
// Builds against the locally-installed CLion (no IDE SDK download). Adjust the
// `local(...)` path / `sinceBuild` for your IDE.

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.4.0"
    id("org.jetbrains.intellij.platform") version "2.16.0"
}

group = "com.azerothjs"
version = "0.3.0-alpha.3"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        local("C:/Users/IntelligentQuantum/AppData/Local/Programs/WebStorm")
        bundledPlugin("org.jetbrains.plugins.textmate")
    }
}

kotlin {
    jvmToolchain(21)
}

// --- Bundle the AzerothJS language server INTO the plugin so it is fully
// --- self-contained (no dependency on a VS Code install). The bundled server
// --- is the esbuild-built server.js plus a copy of TypeScript (which the
// --- server needs for its lib/*.d.ts). Run `npm run bundle -w azerothjs-vscode`
// --- first so editors/vscode/dist/server.js exists.
val serverBundle = layout.buildDirectory.dir("azeroth-server")

val bundleServer by tasks.registering(Copy::class) {
    val serverJs = file("$rootDir/../vscode/dist/server.js")
    val typescript = file("$rootDir/../../node_modules/typescript")
    from(serverJs) { into("server") }
    from(typescript) {
        into("server/node_modules/typescript")
        include("package.json", "lib/**")
    }
    into(serverBundle)
}

tasks.named<org.gradle.api.tasks.bundling.Zip>("buildPlugin") {
    dependsOn(bundleServer)
    // The Zip already roots content under the plugin directory, so place the
    // `server/` folder there directly (no extra plugin-name prefix).
    from(serverBundle)
}
