// Runs the NATIVE TypeScript 7 compiler (the Go tsc, installed under the `tsc7` alias) with
// passthrough arguments. Why the split: the typescript@7 npm package ships the native CLI but
// NOT the JS compiler API (its export is a version stub - createProgram/LanguageService do not
// exist), while @azerothjs/{compiler,language-service,language-server,typescript-plugin} and
// typescript-eslint IMPORT that API at runtime. So the `typescript` dependency stays on the
// 6.x line (the newest release that has the API), and every place that merely RUNS tsc - the
// package builds, the root typecheck, watch mode - goes through this wrapper to the native 7
// compiler. When the 7 API line stabilizes, migrating the tooling packages onto it retires
// this file.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(ROOT, 'node_modules', 'tsc7', 'bin', 'tsc');

const result = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { stdio: 'inherit' });
if ((result.status ?? 1) !== 0)
{
    process.exit(result.status ?? 1);
}

// Publish/pack builds must not ship dangling sourcemap references: every package
// excludes `dist/**/*.map` from its tarball (size discipline), so the trailing
// `//# sourceMappingURL=` comments tsc emits would point at files that do not
// exist in the install - and consumer tooling (vitest's stack mapping, editors)
// follows them into ENOENT noise on every run. The `prepack` lifecycle rebuilds
// through scripts/prepack.mjs, which sets AZEROTH_PACK=1 (npm_command cannot
// carry the signal - a nested `npm run build` resets it to run-script), so
// stripping HERE covers every package; a plain `npm run build` keeps maps for
// local debugging.
if (process.env.AZEROTH_PACK === '1')
{
    const dist = path.resolve('dist');
    let stripped = 0;
    let removed = 0;
    const walk = (dir) =>
    {
        let entries;
        try
        {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch
        {
            return; // no dist (a package without a build output) - nothing to strip
        }
        for (const entry of entries)
        {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory())
            {
                walk(full);
            }
            else if (entry.name.endsWith('.map'))
            {
                rmSync(full);
                removed++;
            }
            else if (/\.(js|cjs|mjs|ts|cts|mts)$/.test(entry.name))
            {
                const text = readFileSync(full, 'utf8');
                const cleaned = text.replace(/^\/\/# sourceMappingURL=.*\r?\n?/gm, '');
                if (cleaned !== text)
                {
                    writeFileSync(full, cleaned);
                    stripped++;
                }
            }
        }
    };
    walk(dist);
    if (stripped > 0 || removed > 0)
    {
        console.log(`tsc7: publish build - stripped ${ stripped } sourceMappingURL reference(s), removed ${ removed } map file(s).`);
    }
}

process.exit(0);
