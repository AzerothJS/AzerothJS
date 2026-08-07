// Every package's `prepack` lifecycle: the normal build, with AZEROTH_PACK=1 in
// the environment so tsc7.mjs strips sourcemap references from dist afterward.
// The flag exists because npm_command cannot carry the signal: `prepack` running
// `npm run build` spawns a NESTED npm whose npm_command is `run-script`, erasing
// any trace of the outer pack/publish before the build script can see it.
import { spawnSync } from 'node:child_process';

const result = spawnSync('npm', ['run', 'build'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, AZEROTH_PACK: '1' }
});
process.exit(result.status ?? 1);
