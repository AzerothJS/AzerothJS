// @azerothjs/typescript-plugin
//
// A TypeScript language-service plugin (the @vue/typescript-plugin equivalent).
// Registered in a consuming project's tsconfig:
//
//   { "compilerOptions": { "plugins": [{ "name": "@azerothjs/typescript-plugin" }] } }
//
// tsserver (the engine behind VS Code's built-in TypeScript, and any editor
// using it) loads this plugin and, through it, resolves `.azeroth` imports from
// `.ts`/`.tsx` files with their REAL exported types - default, named, and type
// exports - so a consuming app no longer needs a hand-written
// `declare module '*.azeroth'` shim.
//
// Note: TypeScript language-service plugins run only inside tsserver, not inside
// the command-line `tsc`. For a `tsc`-style gate over `.azeroth` files, use the
// `azeroth-tsc` binary from `@azerothjs/language-server`.

import type tsModule from 'typescript';
import { decorateLanguageServiceHost } from './decorate.ts';

/** The tsserver plugin factory. tsserver calls this with the `typescript` module. */
function init(modules: { typescript: typeof tsModule }): tsModule.server.PluginModule
{
    const ts = modules.typescript;

    return {
        create(info: tsModule.server.PluginCreateInfo): tsModule.LanguageService
        {
            // Decorate the host in place so resolution/loading of `.azeroth`
            // modules takes effect on the next program build. The language
            // service itself is returned unchanged; all behaviour flows from the
            // host now understanding `.azeroth`.
            decorateLanguageServiceHost(ts, info.languageServiceHost);
            info.project.projectService.logger.info('[azerothjs] typescript-plugin: .azeroth module resolution enabled');
            return info.languageService;
        },

        getExternalFiles(project: tsModule.server.Project): string[]
        {
            // Surface `.azeroth` dependencies so tsserver watches them and
            // refreshes the program when they change on disk.
            return project.getFileNames().filter((fileName) => fileName.endsWith('.azeroth'));
        }
    };
}

export = init;
