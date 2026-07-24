// Reproducible .vsix builder.
//
// Packaging from inside the monorepo fails: vsce resolves the hoisted
// `typescript` dependency outside the package directory. So this script bundles
// the extension + server (esbuild.mjs), stages a *standalone* copy in a temp
// directory with only its production dependency (typescript, which ships its
// own lib/*.d.ts), installs it there, and runs vsce. The resulting .vsix is
// self-contained and installs with `code --install-extension`.
//
//   node package.mjs            -> builds dist/azerothjs-vscode-<version>.vsix
//   node package.mjs --install  -> also installs it into VS Code

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));
// On Windows, npm/npx/code are `.cmd` shims and need a shell; node does not
// (and its path contains a space, which a shell would mis-split).
const run = (cmd, args, cwd) => execFileSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32' && cmd !== process.execPath
});

// 1) Bundle extension + server into self-contained CJS.
run(process.execPath, [path.join(here, 'esbuild.mjs')], here);

// 2) Stage a standalone copy outside the workspace.
const stage = mkdtempSync(path.join(tmpdir(), 'azeroth-vsix-'));
for (const entry of ['dist', 'syntaxes', 'icons', 'language-configuration.json', 'README.md', 'LICENSE', 'icon.png'])
{
    cpSync(path.join(here, entry), path.join(stage, entry), { recursive: true });
}
rmSync(path.join(stage, 'dist'), { recursive: true, force: true });
cpSync(path.join(here, 'dist'), path.join(stage, 'dist'), { recursive: true });
for (const file of readdirSync(path.join(stage, 'dist')))
{
    if (file.endsWith('.map'))
    {
        rmSync(path.join(stage, 'dist', file));
    }
}

// 3) Strip dev/bundled deps; keep only the runtime-external `typescript`.
const staged = { ...pkg };
delete staged.devDependencies;
delete staged.scripts;
// Pin to the classic-API TypeScript line (<7): the tsserver plugin needs createProgram/
// LanguageService, which TypeScript 7's native package does not expose. A bare `>=6` would
// resolve 7.x here and break the plugin (and vsce would mark it invalid).
staged.dependencies = { typescript: pkg.dependencies?.typescript ?? '>=6 <7' };
writeFileSync(path.join(stage, 'package.json'), JSON.stringify(staged, null, 2));
writeFileSync(path.join(stage, '.vscodeignore'), 'src/**\n**/*.map\n');

// 4) Install the lone production dep locally (no hoisting).
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], stage);

// 4b) Stage the TypeScript plugin physically under node_modules so the built-in
// TS server can resolve the `typescriptServerPlugins` contribution by name. It
// is bundled (self-contained CJS), so only its package.json + dist are needed.
// Copy from the built workspace package rather than `npm install` so the vsix is
// reproducible before the plugin is published.
const pluginSrc = path.join(here, '..', '..', 'packages', 'typescript-plugin');
const pluginDist = path.join(pluginSrc, 'dist', 'index.js');
if (!existsSync(pluginDist))
{
    throw new Error(`missing ${ pluginDist } - run "npm run build -w @azerothjs/typescript-plugin" first`);
}
const pluginDest = path.join(stage, 'node_modules', '@azerothjs', 'typescript-plugin');
cpSync(path.join(pluginSrc, 'dist'), path.join(pluginDest, 'dist'), { recursive: true });
copyFileSync(path.join(pluginSrc, 'package.json'), path.join(pluginDest, 'package.json'));

// 4c) NOW that the plugin is physically present, DECLARE it in the staged manifest so vsce's
// `npm list --production` sees it as satisfied (not extraneous). It is written AFTER the
// install in step 4 so npm never tries to fetch the unpublished package from the registry.
staged.dependencies = { '@azerothjs/typescript-plugin': pkg.dependencies?.['@azerothjs/typescript-plugin'] ?? '*', ...staged.dependencies };
writeFileSync(path.join(stage, 'package.json'), JSON.stringify(staged, null, 2));

// 5) Package the .vsix. vsce's npm-list probe now passes (typescript is a valid <7, the
// plugin is declared and physically present), so node_modules - including typescript's
// lib/*.d.ts the language service loads at runtime - is packaged.
run('npx', ['--yes', '@vscode/vsce@latest', 'package'], stage);

// 5) Copy the .vsix back into dist/.
const vsix = readdirSync(stage).find(f => f.endsWith('.vsix'));
const out = path.join(here, 'dist', vsix);
copyFileSync(path.join(stage, vsix), out);
rmSync(stage, { recursive: true, force: true });
console.log(`\npackaged: ${ out }`);

if (process.argv.includes('--install'))
{
    run('code', ['--install-extension', out, '--force']);
}
