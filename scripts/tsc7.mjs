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
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(ROOT, 'node_modules', 'tsc7', 'bin', 'tsc');

const result = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
