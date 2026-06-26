// Runs publint against every published @azerothjs/* package and fails if any
// package has a warning or error. Suggestions are printed but do NOT fail the
// run (publint's own exit-code policy). publint validates the published
// package.json contract - exports condition ordering, types resolution, format
// vs `type`, and that referenced files actually ship - which nothing else in the
// pipeline exercises: the test suite and type-checks all run against src through
// workspace aliases, never through the published `exports` map. Requires dist to
// exist (run `npm run build` first).
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(ROOT, 'packages');
const failed = [];

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
    try
    {
        execSync(`npx publint "${ dir }"`, { cwd: ROOT, stdio: 'inherit' });
    }
    catch
    {
        failed.push(manifest.name);
    }
}

if (failed.length > 0)
{
    console.error(`\npublint failed (warnings/errors) for: ${ failed.join(', ') }`);
    process.exit(1);
}

console.log('\npublint: all published packages OK.');
