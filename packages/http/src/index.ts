/**
 * MODULE: http - the AzerothJS server kernel
 *
 * A zero-dependency HTTP stack for Node >= 24 built on web-standard Request/Response:
 * handlers are `(request, ctx) => Response`, the Node adapters (node:http/https/http2) live
 * at the edge, and `app.handle(new Request(...))` is the entire testing story. Every request
 * runs inside a reactive root (`createRoot` + `runInStoreScope`), so `onCleanup` is request
 * teardown, stores are request-isolated exactly as they are under SSR, and the client
 * disconnect AbortSignal aborts in-flight work - the same lifecycle vocabulary components
 * have on the frontend.
 *
 * The package is organized in four layers. The KERNEL maps one Request to one Response:
 * routing (router.ts), the single error path (errors.ts), response constructors (respond.ts),
 * body readers with limits (body.ts, multipart.ts), cookies, static files, compression, and
 * Server-Sent Events (sse.ts). The APP MODEL composes above it: typed middleware and plugins
 * (app.ts), the per-request root (request-root.ts), configuration (config.ts), and logging
 * (logger.ts). The EDGE wraps the whole app for cross-cutting response concerns - request ids
 * (edge.ts), security headers (security.ts), CORS (cors.ts), rate limiting (rate-limit.ts),
 * composed with `pipeline()`. The ADAPTERS sit below: node:http and h2c servers with graceful
 * shutdown and tunable socket timeouts (adapter-node.ts) plus the lazy Request/Response shims
 * that keep the hot path allocation-light (adapter-request.ts, payload.ts).
 */

export { RadixRouter } from './router.ts';
export type { PathParams, RouteResult, RouteMatch, RouteMethodMismatch, RouteMiss } from './router.ts';

export { App } from './app.ts';
export type { AppOptions, Handler, Middleware, RequestContext, RequestObserver, AzerothPlugin } from './app.ts';

export { onRequestCleanup, runInRequestRoot } from './request-root.ts';

export { loadConfig, str, num, flag, oneOf } from './config.ts';
export type { ConfigVar, ConfigOf } from './config.ts';

export { createLogger, jsonSink, prettySink, logRequests } from './logger.ts';
export type { Logger, LogLevel, LogRecord, LogSink } from './logger.ts';

export {
    HttpError, BadRequestError, UnauthorizedError, ForbiddenError, NotFoundError,
    MethodNotAllowedError, ConflictError, PayloadTooLargeError, UnsupportedMediaTypeError,
    ValidationError, TooManyRequestsError, errorResponse
} from './errors.ts';
export type { ErrorObserver } from './errors.ts';

export { json, text, html, redirect, noContent, created, queryResult, acceptQuery } from './respond.ts';
export type { QueryResultOptions } from './respond.ts';
export { jsonEncoder } from './encode-json.ts';
export type { EncodableSchema, EncoderMeta } from './encode-json.ts';

export { readRaw, readText, readJson, readForm, readValidated, mediaTypeOf, DEFAULT_BODY_LIMIT } from './body.ts';
export type { ReadOptions, SchemaLike, ValidationIssue } from './body.ts';

export { serve, serveH2c, toWebRequest, writeResponse, handleShutdownSignals } from './adapter-node.ts';
export type { Served, WebHandler, ConnectMiddleware, SocketTimeouts, ShutdownSignalOptions } from './adapter-node.ts';

export { pipeline, withResponseHeaders, requestId, requestIdOf } from './edge.ts';
export type { EdgeMiddleware, RequestIdOptions } from './edge.ts';

export { securityHeaders } from './security.ts';
export type { SecurityHeadersOptions, HstsOptions } from './security.ts';

export { cors } from './cors.ts';
export type { CorsOptions, CorsOrigin } from './cors.ts';

export { clientIp } from './client-ip.ts';
export type { ClientIpOptions } from './client-ip.ts';

export { rateLimit, MemoryRateStore } from './rate-limit.ts';
export type { RateStore, RateLimitOptions, RateLimitDecision } from './rate-limit.ts';

export { readMultipart, boundaryOf } from './multipart.ts';
export type { MultipartBody, MultipartOptions, UploadedFile } from './multipart.ts';

export { parseCookies, serializeCookie, expireCookie } from './cookies.ts';
export type { CookieOptions } from './cookies.ts';

export { staticFiles, contentTypeFor } from './static.ts';
export type { StaticOptions } from './static.ts';

export { compressResponse } from './compress.ts';
export type { CompressOptions } from './compress.ts';

export { sse } from './sse.ts';
export type { SseConnection, SseOptions, SseSendOptions } from './sse.ts';
