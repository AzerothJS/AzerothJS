# AzerothJS for JetBrains

## Overview

A native, self-contained IntelliJ-platform plugin for the paid JetBrains IDEs
(WebStorm, PhpStorm, IDEA Ultimate, CLion, and others). It provides syntax
highlighting, completion, hover, diagnostics, navigation, rename, formatting, and
editing aids for `.azeroth` files.

The plugin uses the platform's own APIs and bundles the AzerothJS language server
inside the distribution, so it does not depend on the VS Code extension. The only
runtime requirement is Node.js on `PATH`.

Note: the LSP API ships only in the paid JetBrains IDEs, not the free Community
editions.

## Architecture

The plugin combines two platform mechanisms with the bundled server:

- The TextMate engine provides TSX-style highlighting (HTML, JSX, TypeScript).
  The AzerothJS grammar embeds `source.tsx`, and the real TypeScript and
  TypeScript-React grammars are bundled so highlighting matches a `.tsx` file.
- The platform LSP API (`com.intellij.platform.lsp`, 2023.2 and later) provides
  the compiler-accurate intelligence by talking to the bundled language server.
- A settings panel sends per-feature toggles to the server as LSP
  `initializationOptions`.

```
JetBrains IDE
  TextMate engine          highlighting (azeroth grammar embeds source.tsx)
  LspServerSupportProvider starts the bundled server, routes LSP requests
  settings panel           toggles sent as initializationOptions
        |
        bundled server (server/server.js + its own TypeScript)
        |
        language service (compiler-aware analysis)
```

### How it interacts with the language server and service

`AzerothLspServerSupportProvider` tells the IDE to start the bundled server for
`.azeroth` files; from there the IDE's LSP client handles completion, hover,
diagnostics, navigation, and the rest by talking to that server. The server
forwards each request to `@azerothjs/language-service`. So the same analysis
backs both editors; only the host wiring differs. `AzerothTypedHandler` adds
type-driven editing behavior (such as triggering completion) on the IDE side.

### Why LSP plus TextMate, and not a native TypeScript parser

`.azeroth` markup is JSX-shaped, so it is tempting to register it as
TypeScript-JSX and let the IDE's native TypeScript engine analyze it. That engine
does not know AzerothJS semantics and would report false errors (`Show` is not
imported, JSX requires React, the `h()` factory, reactive wrapping). The bundled
server reuses the AzerothJS compiler, so its analysis is correct. TextMate
supplies the native highlighting without a second, incorrect analyzer. WebStorm's
own TypeScript support also runs a Node `tsserver` under the hood, so a bundled
Node server is a normal arrangement.

## Components

| Path | Role |
| --- | --- |
| `src/main/kotlin/com/azerothjs/AzerothLspServerSupportProvider.kt` | Starts the bundled server and describes the LSP integration. |
| `src/main/kotlin/com/azerothjs/AzerothTextMateBundleProvider.kt` | Registers the bundled TextMate grammars. |
| `src/main/kotlin/com/azerothjs/AzerothTypedHandler.kt` | Type-driven editing behavior on the IDE side. |
| `src/main/kotlin/com/azerothjs/AzerothSettings.kt` | Persistent settings state. |
| `src/main/kotlin/com/azerothjs/AzerothConfigurable.kt` | The Settings panel (Languages and Frameworks, AzerothJS). |
| `src/main/resources/META-INF/plugin.xml` | Plugin descriptor and extension registrations. |
| `src/main/resources/textmate/*` | The bundled grammars and language configuration. |

## Development

Open `editors/jetbrains` as a Gradle project. The build runs against a locally
installed IDE rather than downloading an SDK, so set the `local(...)` path in
`build.gradle.kts` to your IDE home and adjust `sinceBuild` if needed. The IDE
build uses Kotlin 2.4.0 and the IntelliJ Platform Gradle plugin 2.16.0, which
requires Gradle 9 or later.

Pin the Kotlin version to match your IDE's bundled-library metadata; a mismatch
fails the build with a metadata-version error.

## Building

Requires JDK 21 (set `JAVA_HOME`) and Gradle 9 or later. Build the server bundle
first, then the plugin:

```sh
npm run bundle -w azerothjs-vscode    # produces editors/vscode/dist/server.js
cd editors/jetbrains
gradle buildPlugin                    # build/distributions/azerothjs-jetbrains-<version>.zip
```

`buildPlugin` depends on a `bundleServer` task that copies `server.js` and a
trimmed copy of TypeScript (its `lib/*.d.ts` is needed at runtime) into the
plugin's `server/` directory, which is why the npm bundle step must run first.

## Testing

Run the plugin in a sandbox IDE with `gradle runIde`, then open a `.azeroth` file
and check highlighting, completion, hover, diagnostics, and tag auto-close. The
underlying language analysis is covered by the language-service test suite at the
repository root (`npm test`).

## Configuration

Settings are under Settings, Languages and Frameworks, AzerothJS. The toggles are
stored by `AzerothSettings` and sent to the server as `initializationOptions`, so
they map onto the same per-feature options the VS Code extension uses. TypeScript
intelligence uses the nearest `tsconfig.json` in the project.

## Installation

Install the built zip through Settings, Plugins, the gear menu, Install Plugin
from Disk, or extract it into `<IDE-config>/plugins/` and restart. A plugin is
loaded at startup, so restart the IDE after installing or updating.

## Examples

Open `packages/compiler/examples/Showcase.azeroth` to exercise the features by
hand.

## Contributing

Keep language analysis in `@azerothjs/language-service`; the Kotlin side should
only handle IDE wiring (starting the server, highlighting, settings, editing
hooks). When the server gains a capability, the LSP client picks it up through
capability negotiation, so most changes here are limited to settings or editing
behavior.
