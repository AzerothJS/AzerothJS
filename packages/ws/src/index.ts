/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The AzerothJS WebSocket server.
 *
 * RFC 6455 from scratch, zero dependencies: the opening handshake (handshake.ts), the
 * frame codec with every section-5 rule as a typed close code (frames.ts), the message
 * state machine with incremental UTF-8 validation and the closing handshake (socket.ts),
 * and the attach layer for @azerothjs/http's serve() or any Node HTTP server (attach.ts).
 */

export { attachWebSockets } from './attach.ts';
export type { AttachOptions } from './attach.ts';

export { ServerSocket } from './socket.ts';
export type { ServerSocketOptions } from './socket.ts';

export { FrameParser, serializeFrame, closePayload, parseClosePayload, ProtocolError, OPCODE } from './frames.ts';
export type { Frame, ParserOptions } from './frames.ts';

export { validateHandshake, acceptValueFor, upgradeResponse } from './handshake.ts';
export type { HandshakeRejection } from './handshake.ts';
