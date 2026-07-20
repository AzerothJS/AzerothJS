<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/logo-transparent.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/ws

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fws?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/ws)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained reactive framework. A WebSocket server implementing RFC 6455 from scratch: zero dependencies, every protocol rule enforced with its mandated close code.

## Install

```sh
npm install @azerothjs/ws
```

## Overview

```ts
import { serve } from '@azerothjs/http';
import { attachWebSockets } from '@azerothjs/ws';

const served = await serve(app);
attachWebSockets(served.server, {
    path: '/ws',
    verifyOrigin: (origin) => origin === 'https://app.example', // refuse cross-site hijacking pre-upgrade
    heartbeatMs: 30_000,                                        // reclaim half-open connections
    onConnection(socket, request)
    {
        socket.send('welcome');
        socket.onMessage = (data) => socket.send(data);        // string = text, bytes = binary
        socket.onClose = (code, reason) => console.log(code);
    }
});
```

The server-side API mirrors the browser's `WebSocket` (send / close / handler properties), so
both ends of a connection read the same way.

## What the implementation covers

- **The opening handshake** - strict validation, `Sec-WebSocket-Accept` derivation
  (verified against RFC 6455's own worked example), plain HTTP refusals for anything
  non-compliant; never a half-upgrade.
- **The frame codec** - an incremental parser over arbitrary TCP chunking. Masking rules,
  RSV bits, reserved opcodes, control-frame constraints, and minimal length encodings are
  each enforced as a typed `ProtocolError` carrying the close code the connection must die
  with (1002/1007/1009).
- **The message state machine** - fragmentation with interleaved control frames, automatic
  ping -> pong, incremental UTF-8 validation (invalid text fails fast at 1007, mid-stream),
  independent per-frame and per-message size caps, and the full closing handshake with code
  validation in both directions.
- **Lifecycle honesty** - `attachWebSockets` returns a detach function that also destroys
  live connections: upgraded sockets leave the HTTP server's connection tracking, so a
  graceful shutdown would otherwise wait on them forever.
- **Production controls** - `verifyOrigin` gates the upgrade before the socket exists (the
  cross-site WebSocket hijacking defense); a heartbeat pings idle peers and terminates any
  that miss the pong deadline (half-open reclamation); and `socket.bufferedAmount` plus an
  awaitable `drain()` let a producer respect backpressure instead of buffering a slow
  consumer's stream in memory.

## How it is tested

Interop runs against Node's built-in `WebSocket` client (undici) - a foreign implementation,
so echo, binary, server push, and the close handshake passing is genuine conformance, not
the package agreeing with itself. A raw-socket client then drives the violation matrix
(unmasked frames, invalid UTF-8, orphan continuations, oversized messages, wire-invalid
close codes) and a seeded fuzz feeds the parser garbage: the contract is frames or
`ProtocolError`, never a crash or a hang.

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
