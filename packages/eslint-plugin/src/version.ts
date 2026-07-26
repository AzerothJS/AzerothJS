/**
 * MODULE: eslint-plugin/version
 *
 * The plugin's own package version, read from its manifest at load time so the ESLint
 * `meta.version` surfaces can never drift from the published version. `../package.json`
 * resolves to the package root from BOTH `src/` (the repo's src-aliased test runs) and
 * `dist/` (the published layout).
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const packageVersion: string = (require('../package.json') as { version: string }).version;
