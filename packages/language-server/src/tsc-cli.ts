#!/usr/bin/env node
// Binary entry point for `azeroth-tsc`. Runs one batch type-check and exits
// non-zero when any `.azeroth` file has an error, so it drops into CI and
// pre-commit the same way `tsc --noEmit` does. All behaviour lives in the
// testable `runTsc`.

import { runTsc, watchTsc, parseArgs } from './tsc.ts';

const options = parseArgs(process.argv.slice(2));

if (options.watch)
{
    // The fs watcher keeps the event loop alive; the process stays up until the
    // user interrupts it. Errors are reported each pass but don't exit the loop.
    watchTsc(options);
}
else
{
    const { errorCount } = runTsc(options);
    process.exit(errorCount > 0 ? 1 : 0);
}
