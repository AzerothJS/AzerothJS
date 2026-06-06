#!/usr/bin/env node
// Binary entry point for `azeroth-tsc`. Runs one batch type-check and exits
// non-zero when any `.azeroth` file has an error, so it drops into CI and
// pre-commit the same way `tsc --noEmit` does. All behaviour lives in the
// testable `runTsc`.

import { runTsc, parseArgs } from './tsc.ts';

const { errorCount } = runTsc(parseArgs(process.argv.slice(2)));
process.exit(errorCount > 0 ? 1 : 0);
