// Publish smoke test (zero runtime dependencies). Packs every published
// @azerothjs/* package, installs the resulting tarballs together into a
// throwaway consumer project, imports the umbrella + compiler, and checks the
// bin targets ship. This is the only check that exercises the real install and
// module-resolution path: the test suite and type-checks run against src through
// workspace aliases, so a broken `exports` map, an undeclared runtime
// dependency, or a corrupted inter-package version pin (the release script
// rewrites those pins in bulk, and workspace symlinks mask any error locally) is
// invisible until a consumer runs `npm install`. Requires `npm run build` first.
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(ROOT, 'packages');

function run(command, cwd)
{
    execSync(command, { cwd, stdio: 'inherit' });
}

const packages = [];
for (const entry of readdirSync(packagesDir))
{
    const dir = path.join(packagesDir, entry);
    const manifestPath = path.join(dir, 'package.json');
    if (!existsSync(manifestPath))
    {
        continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.private)
    {
        continue;
    }
    if (!existsSync(path.join(dir, 'dist')))
    {
        console.error(`smoke: ${ manifest.name } has no dist/ - run \`npm run build\` first.`);
        process.exit(1);
    }
    packages.push({ name: manifest.name, dir });
}

const work = mkdtempSync(path.join(tmpdir(), 'azeroth-smoke-'));
const tarballsDir = path.join(work, 'tarballs');
const consumer = path.join(work, 'consumer');
mkdirSync(tarballsDir);
mkdirSync(consumer);

try
{
    console.log(`Packing ${ packages.length } packages...`);
    for (const pkg of packages)
    {
        run(`npm pack --pack-destination "${ tarballsDir }" --loglevel=error`, pkg.dir);
    }

    const tarballs = readdirSync(tarballsDir)
        .filter((f) => f.endsWith('.tgz'))
        .map((f) => `"${ path.join(tarballsDir, f) }"`);
    if (tarballs.length !== packages.length)
    {
        throw new Error(`expected ${ packages.length } tarballs, found ${ tarballs.length }`);
    }

    writeFileSync(
        path.join(consumer, 'package.json'),
        JSON.stringify({ name: 'azeroth-smoke-consumer', private: true, version: '0.0.0', type: 'module' }, null, 4)
    );

    console.log('Installing tarballs into a clean consumer project...');
    run(`npm install ${ tarballs.join(' ') } --no-save --no-fund --no-audit --ignore-scripts --loglevel=error`, consumer);

    // Importing the entry package forces every inter-package pin to resolve and
    // every module to load under Node (the SSR contract); a handful of expected
    // symbols guards against the umbrella silently losing a layer's re-exports.
    const probe = `
import * as compiler from '@azerothjs/compiler';
import * as azerothjs from 'azerothjs';
for (const [name, mod] of [['azerothjs', azerothjs], ['@azerothjs/compiler', compiler]])
{
    if (Object.keys(mod).length === 0) throw new Error(name + ' resolved but exported nothing');
}
for (const key of ['createSignal', 'h', 'render', 'Show', 'For', 'createForm', 'createStore', 'createRouter', 'renderToString'])
{
    if (!(key in azerothjs)) throw new Error('azerothjs is missing expected export: ' + key);
}
console.log('import OK:', Object.keys(azerothjs).length, 'azerothjs exports,', Object.keys(compiler).length, 'compiler exports');
`;
    writeFileSync(path.join(consumer, 'probe.mjs'), probe);
    run('node probe.mjs', consumer);

    // The bin targets must actually ship - a wrong path in "bin" is invisible
    // until a user runs the CLI.
    const lsDir = path.join(consumer, 'node_modules', '@azerothjs', 'language-server');
    const lsManifest = JSON.parse(readFileSync(path.join(lsDir, 'package.json'), 'utf8'));
    for (const [binName, rel] of Object.entries(lsManifest.bin ?? {}))
    {
        if (!existsSync(path.join(lsDir, rel)))
        {
            throw new Error(`bin "${ binName }" points to a missing file: ${ rel }`);
        }
    }

    console.log('\nsmoke: published artifacts install, resolve, and import correctly.');
}
finally
{
    rmSync(work, { recursive: true, force: true });
}
