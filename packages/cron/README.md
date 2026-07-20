<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/logo-transparent.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/cron

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fcron?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/cron)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained reactive framework. A zero-dependency job scheduler for Node >= 24: real cron expressions with honest timezone/DST semantics, built to fix everything a hand-rolled `setInterval` quietly gets wrong.

## Install

```sh
npm install @azerothjs/cron
```

## Overview

```ts
import { createScheduler } from '@azerothjs/cron';

const scheduler = createScheduler({ onError: (error, job) => logger.error('job failed', { job, error }) });

scheduler.schedule('cleanup', '0 3 * * *', async () => pruneExpiredSessions(), { timeZone: 'America/New_York' });
scheduler.at('digest', '08:30', sendDailyDigest);       // sugar for '30 8 * * *'
scheduler.every('heartbeat', 30_000, pingUpstream);     // fixed-interval jobs

console.log(scheduler.jobs());   // the printable table: next run, last run, outcome, skips
await scheduler.stop();          // disarm + drain in-flight runs (pair with the server's shutdown)
```

## What setInterval gets wrong, fixed by construction

- **Drift.** Every arm computes the NEXT wall-clock occurrence and sets one timeout to it -
  "daily at midnight" stays midnight instead of accumulating lag.
- **Overlap.** A slow run cannot stack behind itself: a tick that fires mid-run is SKIPPED
  (and counted) by default; `overlap: 'concurrent'` opts out.
- **DST.** Expressions evaluate in any IANA timezone via `Intl` (no tz database shipped): a
  local time that does not exist (spring forward) is skipped; a repeated one (fall back)
  fires once. Occurrences missed while the process slept are skipped, never replayed.
- **Visibility.** `jobs()` reports name, expression, timezone, next/last run, last outcome,
  and overlaps skipped; `runNow(name)` triggers a job manually.
- **Crashes.** A throwing job reports to `onError` and keeps its schedule; the observer's own
  throws are swallowed.
- **Shutdown.** `stop({ drain: true })` disarms every timer and awaits in-flight runs up to a
  grace period - fold it into `@azerothjs/http`'s `shutdown()` and deploys stop cleanly.
- **Loud registration.** A malformed expression, unknown timezone, duplicate name, or an
  expression that can never match (`0 0 31 2 *`) throws AT `schedule()`, not at 3am.

## Expressions

Standard 5 fields (`minute hour day-of-month month day-of-week`) with ranges (`1-5`), steps
(`*/15`, `1-30/5`, vixie `10/5`), lists (`mon,wed,fri`), month/day names, and the
`@yearly` `@monthly` `@weekly` `@daily` `@hourly` aliases. When day-of-month AND day-of-week
are both restricted, a date matching EITHER runs (the vixie rule). The engine itself is
exported - `parseExpression` + `nextOccurrence` answer "when would this run next?" anywhere.

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
