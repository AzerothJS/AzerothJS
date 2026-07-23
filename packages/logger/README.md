<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/logo-transparent.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/logger

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Flogger?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/logger)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained reactive framework. One zero-dependency logger with two faces: colored, iconed developer output on a TTY, and pino-class NDJSON for production - plus the banner every AzerothJS process starts with.

## Install

```sh
npm install @azerothjs/logger
```

## Overview

```ts
import { createLogger } from '@azerothjs/logger';

const log = createLogger({ redact: ['authorization'] });

log.info('server listening', { port: 3000 });
log.warn('slow handler', { route: '/api/search', durationMs: 1203 });
log.error('request failed', { error: new Error('upstream timeout', { cause: reason }) });

const requestLog = log.child({ requestId: 'r-42' }); // context binds once, rides every line
requestLog.debug('cache miss', { key: 'user:7' });
```

The SAME calls render for whoever is watching:

**A developer's terminal** (TTY, not production) - one aligned line per event, compact
timestamp, a level icon in its color, dim `key=value` fields, errors as indented blocks
with the `cause` chain walked:

```
14:32:07.412 ● info  server listening  port=3000
14:32:09.833 ▲ warn  slow handler  route=/api/search durationMs=1203
14:32:11.020 ✖ error request failed
    at handler (src/routes.ts:42:11)
    caused by: Error: upstream timeout
```

**Production / a pipe / a collector** - byte-clean NDJSON, one line per event, stable key
order, epoch-millis time, no ANSI ever:

```json
{"level":"info","time":1770000000000,"msg":"server listening","port":3000}
{"level":"warn","time":1770000002421,"msg":"slow handler","route":"/api/search","durationMs":1203}
```

Face selection is automatic (TTY + `NODE_ENV !== 'production'` = pretty, anything else =
NDJSON) and overridable: `createLogger({ face: 'ndjson' })` in code, or `AZEROTH_LOG=json`,
`AZEROTH_LOG=debug`, `AZEROTH_LOG=pretty:trace` from the environment. In a browser, levels
map onto styled `console` methods.

## What the design promises

- **A disabled level is free.** Below-threshold methods ARE a shared no-op - a
  `log.trace(...)` in a hot loop costs a plain call, so instrumentation can stay in
  production code. Guard genuinely expensive field construction with `log.enabled('debug')`.
- **Child context is serialized once.** `child(fields)` pre-renders its bindings into the
  NDJSON line, so contextual logging (request ids, job ids) costs what one extra string
  concat costs - measured ahead of pino on the emit paths, ~10x ahead of winston.
- **Redaction happens before any sink.** `redact: ['authorization', 'cookie']` replaces
  values at the logger, so no formatter, transport, or adapter can leak them.
- **Errors are first-class.** Any `Error` field serializes as `{ name, message, stack }`
  with the full `cause` chain (depth-capped against cycles).
- **The color social contract is honored.** `NO_COLOR` always wins; `FORCE_COLOR` colors a
  pipe for CI viewers; a non-TTY stream is byte-clean; icons degrade to ASCII on terminals
  that cannot render them.

## The banner

The framework's face at startup - `@azerothjs/http`'s `serve()` and the Vite dev plugin
print it, and anything built on AzerothJS can too:

```ts
import { printBanner } from '@azerothjs/logger';

printBanner({
    version: '1.4.0',
    subtitle: 'worker',
    entries: [['Queue', 'jobs'], ['Concurrency', '8']],
    readyMs: performance.now() - startedAt
});
```

```
  ▲ AzerothJS v1.4.0  worker

    Queue        jobs
    Concurrency  8

    ✓ Ready in 12 ms
```

`printBanner` self-gates: it renders only on an interactive terminal outside production -
a piped or collected stream never carries it. The ready time is whatever YOU measured; the
banner never invents numbers.

## Environment

| Variable | Effect |
| --- | --- |
| `AZEROTH_LOG` | `debug` (level), `json` / `pretty` (face), or both: `json:info` |
| `NO_COLOR` | disables all color, everywhere, unconditionally |
| `FORCE_COLOR` | forces color onto a non-TTY (`1`/`2`/`3` = 16/256/truecolor) |
| `NODE_ENV=production` | auto face picks NDJSON and the banner stays silent |

## Log files

Point the logger at a file to append forever, or at a FOLDER for day-named files with
size rotation and retention - rotation is rename-free (a new name opens, the old file
just stops growing), which is what makes it correct on Windows, where an open file
cannot be renamed and antivirus loves holding handles:

```ts
import { createLogger, fileStream } from '@azerothjs/logger';

// logs/app-2026-07-21.ndjson, app-2026-07-21.2.ndjson, ... - NDJSON, never ANSI
const log = createLogger({ stream: fileStream('logs/', { maxFileBytes: 32 * 1024 * 1024, maxFiles: 14 }) });
```

This rides the fused NDJSON fast path untouched. Lines batch in a bounded buffer and
hit disk on a size threshold, a flush interval (default 1 s), `flush()`/`close()`, and
process exit - so a `process.exit()` or a graceful SIGTERM loses nothing, and an
external hard kill loses at most the flush interval. When the disk cannot keep up or a
write fails, lines are DROPPED and counted - never blocking the event loop, never
growing unbounded - with one stderr notice and a `log lines dropped` record on
recovery: logging must never break the system.

Both faces at once - pretty for eyes, a file for the record:

```ts
import { createLogger, prettySink, fileSink, teeSink } from '@azerothjs/logger';

const file = fileSink('logs/');
const log = createLogger({ sink: teeSink(prettySink(), file) });
// on shutdown: file.close()  (flushes; process exit also flushes automatically)
```

And with `@azerothjs/http`, one line per request into the folder:

```ts
new App({ observe: logRequests(createLogger({ stream: fileStream('logs/') })) });
```

## Custom sinks

A sink is one function; everything else is composition:

```ts
import { createLogger } from '@azerothjs/logger';

const seen: unknown[] = [];
const log = createLogger({ sink: (record) => seen.push(record) }); // a test spy
```

The record - `{ level, message, time, fields }` - is the whole contract; an OpenTelemetry
adapter, a test spy, or `@azerothjs/http`'s request logging all consume it structurally.
For files, prefer `fileStream`/`fileSink` above - they add the batching, rotation, and
crash-safety a bare write stream does not have.

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
