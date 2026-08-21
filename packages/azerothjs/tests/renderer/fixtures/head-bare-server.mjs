// The bare-server useHead arm's child body: NO DOM globals, the BUILT dist (what a
// consumer executes). Pre-fix this process died with an UNCATCHABLE microtask
// ReferenceError (exit 1) because useHead armed the sweep before validating a document
// exists; post-fix the call is a diagnosed no-op and the process survives every phase.
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The repo root, derived from THIS file's location - never a machine-local absolute path.
const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', '..');
const dist = (rel) => pathToFileURL(join(repo, rel)).href;

if (typeof document !== 'undefined')
{
    console.log(JSON.stringify({ error: 'a document exists; this arm requires a bare server' }));
    process.exit(1);
}

const { useHead } = await import(dist('packages/azerothjs/dist/index.js'));

let syncThrew = false;
try
{
    useHead({ title: 'bare-server-title', meta: [{ name: 'description', content: 'x' }] });
}
catch
{
    syncThrew = true;
}

// The pre-fix kill fired one microtask later, past every catch. Survive two checkpoints.
await new Promise((resolve) => queueMicrotask(resolve));
await new Promise((resolve) => setTimeout(resolve, 10));

console.log(JSON.stringify({ survived: true, syncThrew }));
