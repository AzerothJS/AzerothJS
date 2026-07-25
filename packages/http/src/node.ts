/**
 * MODULE: @azerothjs/http/node - the Node.js half
 *
 * Everything that touches node:* at module load lives behind THIS subpath: the socket
 * adapters (serve/serveH2c, graceful shutdown, keep-alive tuning), filesystem static
 * serving, and zlib compression. The "." entry is the pure fetch-standard kernel - a
 * runtime without these modules (Cloudflare Workers, Vercel Edge) imports the kernel
 * and hosts it via `toFetchHandler`; Node imports both.
 *
 *   import { App, json } from '@azerothjs/http';
 *   import { serve, staticFiles } from '@azerothjs/http/node';
 */

export { serve, serveH2c, toWebRequest, writeResponse, handleShutdownSignals } from './adapter-node.ts';
export type { Served, ConnectMiddleware, SocketTimeouts, ShutdownSignalOptions } from './adapter-node.ts';

export { staticFiles, contentTypeFor } from './static.ts';
export type { StaticOptions } from './static.ts';

export { compressResponse } from './compress.ts';
export type { CompressOptions } from './compress.ts';
