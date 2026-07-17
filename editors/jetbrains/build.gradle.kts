// Build with JDK 21 (set JAVA_HOME): `gradle buildPlugin`.
// The target IDE is resolved from gradle.properties (platformType /
// platformVersion) so the build is reproducible on CI and any machine.

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.4.0"
    id("org.jetbrains.intellij.platform") version "2.18.1"
}

group = "com.azerothjs"
version = "0.8.0-beta.2"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // Reproducible by default: download the target IDE pinned in
        // gradle.properties (platformType / platformVersion), so the build works
        // on CI and any machine. For fast local iteration against an already
        // installed IDE, pass `-PlocalIdePath=<path-to-IDE>` (no machine-specific
        // path is baked into the build).
        val localIdePath = providers.gradleProperty("localIdePath").orNull
        if (localIdePath != null) {
            local(localIdePath)
        } else {
            create(
                providers.gradleProperty("platformType"),
                providers.gradleProperty("platformVersion")
            )
        }
        bundledPlugin("org.jetbrains.plugins.textmate")
    }
}

kotlin {
    jvmToolchain(21)
}

intellijPlatform {
    pluginConfiguration {
        version = project.version.toString()
        ideaVersion {
            // Lower bound from gradle.properties; leave the upper bound open so a
            // young, LSP-only plugin keeps working in newer IDEs instead of being
            // pinned to the build it happened to compile against.
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = provider { null }
        }
    }

    // CI gate: the JetBrains Plugin Verifier checks binary compatibility, plugin.xml
    // structure, and internal/deprecated API usage against the pinned target IDE -
    // failures compileKotlin alone cannot catch. Pinned to the same build the plugin
    // compiles against so the verification matches what we actually target (and the
    // download caches alongside it).
    pluginVerification {
        ides {
            create(
                providers.gradleProperty("platformType"),
                providers.gradleProperty("platformVersion")
            )
        }
    }
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
    // Fail loudly instead of shipping an empty `server/` folder (a plugin that
    // silently can't start its language server).
    doFirst {
        if (!serverJs.exists()) {
            throw GradleException(
                "Missing ${serverJs.path}. Run `npm run bundle -w azerothjs-vscode` " +
                    "first so the language server is bundled before packaging the plugin."
            )
        }
    }
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
