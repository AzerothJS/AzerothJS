/**
 * MODULE: logger/file - persistence: buffered file/folder streams with rotation
 *
 * A FileStream is a WritableLike over a file or a folder, so it plugs into BOTH logger
 * routes: `createLogger({ stream: fileStream('logs/') })` rides the fused NDJSON fast
 * path untouched, and `fileSink()`/`teeSink()` compose it at the record level (pretty
 * console for eyes + NDJSON file for the record - one logger, two destinations).
 *
 * The emit path only ever pushes a string into a bounded in-memory buffer. Bytes reach
 * disk in BATCHES - when the buffer crosses a size threshold, when the flush interval
 * fires, on flush()/close(), and on process exit - via one writeSync per batch: batching
 * amortizes the syscall to nothing while keeping ordering and the exit tail-write
 * trivially correct (no async writer to race against at shutdown).
 *
 * Pointed at a FOLDER, files are named by UTC day (`app-2026-07-21.ndjson`) with a
 * numeric suffix when the size cap rotates within a day. Rotation is RENAME-FREE by
 * design: a new name is opened and the old file simply stops growing. This sidesteps
 * the classic Windows failure (you cannot rename a file something still holds open -
 * antivirus loves to) instead of retrying around it. Retention prunes oldest-first,
 * best-effort: a held handle skips a file until the next rotation. Pointed at a FILE,
 * the stream appends forever and never rotates - rotation is a folder-mode contract.
 *
 * Failure policy mirrors the framework's observer doctrine: logging must never break
 * the system. A full disk, a locked file, a dead fd - the batch is DROPPED and counted,
 * one notice goes to stderr, and a `log lines dropped` record lands in the file on
 * recovery. Nothing here ever throws into the application, and files never see ANSI -
 * a FileStream has no isTTY, so the automatic face always chooses NDJSON over it.
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import type { LogRecord, LogSink } from './record.ts';
import type { WritableLike } from './sinks.ts';
import { ndjsonLine } from './serialize.ts';

export interface FileStreamOptions
{
    /** Flush when the buffer reaches this many bytes; default 64 KiB. */
    maxBufferBytes?: number | undefined;

    /** The longest a line waits in memory before a timed flush; default 1000 ms. */
    flushMs?: number | undefined;

    /** Folder mode: rotate to a numbered sibling when a file would exceed this; default 32 MiB. */
    maxFileBytes?: number | undefined;

    /** Folder mode: keep at most this many files, pruning oldest-first; default 14. */
    maxFiles?: number | undefined;

    /** Folder mode: the base file name (`<name>-<date>.ndjson`); default 'app'. */
    name?: string | undefined;

    /** The buffer's hard cap - beyond it new lines are DROPPED (and counted); default 8 MiB. */
    maxPendingBytes?: number | undefined;

    /** Time source for file naming and the drop notice - injectable for tests. */
    clock?: (() => number) | undefined;
}

/** A buffered file writer that satisfies WritableLike (usable as a logger `stream`). */
export interface FileStream extends WritableLike
{
    /** Writes everything buffered to disk now. Never throws. */
    flush(): void;

    /** Flushes, closes the descriptor, and detaches; later writes are dropped. */
    close(): void;

    /** The file currently being appended (folder mode: changes across rotations). */
    readonly path: string;

    /** Lines dropped so far (buffer cap or write failures). */
    readonly dropped: number;
}

/** A LogSink writing NDJSON records through its own FileStream, exposed for lifecycle. */
export type FileSink = LogSink & Pick<FileStream, 'flush' | 'close' | 'dropped'> & { stream: FileStream };

const DAY_STAMP_LENGTH = 10;

/** @internal Streams with buffered lines, flushed synchronously when the process exits. */
const liveStreams = new Set<BufferedFileStream>();
let exitHookInstalled = false;

function installExitHook(): void
{
    if (exitHookInstalled)
    {
        return;
    }
    exitHookInstalled = true;
    process.on('exit', () =>
    {
        for (const stream of liveStreams)
        {
            stream.flush();
        }
    });
}

class BufferedFileStream implements FileStream
{
    readonly #folderMode: boolean;

    readonly #target: string;

    readonly #maxBufferBytes: number;

    readonly #flushMs: number;

    readonly #maxFileBytes: number;

    readonly #maxFiles: number;

    readonly #name: string;

    readonly #maxPendingBytes: number;

    readonly #clock: () => number;

    #pending: string[] = [];

    #pendingBytes = 0;

    #fd: number | null = null;

    #currentPath = '';

    #fileBytes = 0;

    #dayStamp = '';

    #sequence = 1;

    #droppedLines = 0;

    #announcedDrops = 0;

    #warnedOnce = false;

    #timer: NodeJS.Timeout | null = null;

    #closed = false;

    constructor(target: string, options: FileStreamOptions)
    {
        const absolute = resolve(target);
        this.#folderMode = target.endsWith('/') || target.endsWith(sep)
            || (existsSync(absolute) && statSync(absolute).isDirectory());
        this.#target = absolute;
        this.#maxBufferBytes = options.maxBufferBytes ?? 64 * 1024;
        this.#flushMs = options.flushMs ?? 1000;
        this.#maxFileBytes = options.maxFileBytes ?? 32 * 1024 * 1024;
        this.#maxFiles = options.maxFiles ?? 14;
        this.#name = options.name ?? 'app';
        this.#maxPendingBytes = options.maxPendingBytes ?? 8 * 1024 * 1024;
        this.#clock = options.clock ?? Date.now;
        liveStreams.add(this);
        installExitHook();
    }

    public get path(): string
    {
        return this.#currentPath;
    }

    public get dropped(): number
    {
        return this.#droppedLines;
    }

    public write(chunk: string): boolean
    {
        if (this.#closed)
        {
            return false;
        }
        if (this.#pendingBytes >= this.#maxPendingBytes)
        {
            this.#droppedLines += 1;
            return false;
        }
        this.#pending.push(chunk);
        this.#pendingBytes += chunk.length;
        if (this.#pendingBytes >= this.#maxBufferBytes)
        {
            this.flush();
        }
        else if (this.#timer === null)
        {
            this.#timer = setTimeout(() => this.flush(), this.#flushMs);
            this.#timer.unref();
        }
        return true;
    }

    public flush(): void
    {
        if (this.#timer !== null)
        {
            clearTimeout(this.#timer);
            this.#timer = null;
        }
        if (this.#pending.length === 0)
        {
            return;
        }
        const batchLines = this.#pending.length;
        const batch = this.#pending.join('');
        this.#pending = [];
        this.#pendingBytes = 0;
        try
        {
            this.#ensureTarget(batch.length);
            writeSync(this.#fd as number, batch);
            this.#fileBytes += Buffer.byteLength(batch);
            this.#announceDropsIfAny();
        }
        catch (error)
        {
            // Logging must never break the system: drop the batch, count it, say so once.
            this.#droppedLines += batchLines;
            this.#warnOnce(error);
            this.#closeQuietly();
        }
    }

    public close(): void
    {
        if (this.#closed)
        {
            return;
        }
        this.flush();
        this.#closed = true;
        this.#closeQuietly();
        liveStreams.delete(this);
    }

    /** @internal Opens (or rotates to) the file the next batch belongs in. */
    #ensureTarget(incomingBytes: number): void
    {
        if (!this.#folderMode)
        {
            if (this.#fd === null)
            {
                mkdirSync(dirname(this.#target), { recursive: true });
                this.#openAppend(this.#target);
            }
            return;
        }

        const day = new Date(this.#clock()).toISOString().slice(0, DAY_STAMP_LENGTH);
        if (this.#fd === null || day !== this.#dayStamp)
        {
            mkdirSync(this.#target, { recursive: true });
            this.#dayStamp = day;
            this.#sequence = 1;
            this.#openAppend(this.#filePath());
        }
        // A full file rotates to the next numbered sibling - opening a NEW name, never
        // renaming the old one. An already-oversized empty file never loops: the batch
        // is written anyway (a file may exceed the cap by at most one batch).
        while (this.#fileBytes > 0 && this.#fileBytes + incomingBytes > this.#maxFileBytes)
        {
            this.#sequence += 1;
            this.#openAppend(this.#filePath());
        }
        this.#prune();
    }

    #filePath(): string
    {
        const suffix = this.#sequence === 1 ? '' : `.${ this.#sequence }`;
        return join(this.#target, `${ this.#name }-${ this.#dayStamp }${ suffix }.ndjson`);
    }

    #openAppend(path: string): void
    {
        this.#closeQuietly();
        this.#fd = openSync(path, 'a');
        this.#currentPath = path;
        this.#fileBytes = existsSync(path) ? statSync(path).size : 0;
    }

    /** @internal Oldest-first retention. Best-effort: a held file skips until next time. */
    #prune(): void
    {
        let entries: string[];
        try
        {
            const pattern = new RegExp(`^${ this.#name }-(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d+))?\\.ndjson$`);
            // Age order is (date, sequence) - NOT lexicographic, where the unsuffixed
            // first file of a day would sort after its numbered siblings ('.' < 'n').
            const ageKey = (entry: string): string =>
            {
                const match = pattern.exec(entry);
                return `${ match?.[1] ?? '' }#${ (match?.[2] ?? '1').padStart(9, '0') }`;
            };
            entries = readdirSync(this.#target)
                .filter((entry) => pattern.test(entry))
                .sort((a, b) => (ageKey(a) < ageKey(b) ? -1 : 1));
        }
        catch
        {
            return;
        }
        for (let index = 0; index < entries.length - this.#maxFiles; index++)
        {
            const entry = entries[index];
            if (entry === undefined || join(this.#target, entry) === this.#currentPath)
            {
                continue;
            }
            try
            {
                unlinkSync(join(this.#target, entry));
            }
            catch
            {
                // Windows: something (antivirus, a tail -f) holds it; retry next rotation.
            }
        }
    }

    #announceDropsIfAny(): void
    {
        if (this.#droppedLines <= this.#announcedDrops)
        {
            return;
        }
        const count = this.#droppedLines - this.#announcedDrops;
        this.#announcedDrops = this.#droppedLines;
        try
        {
            writeSync(this.#fd as number, `{"level":"warn","time":${ String(this.#clock()) },"msg":"log lines dropped by file sink","dropped":${ String(count) }}\n`);
        }
        catch
        {
            this.#announcedDrops -= count;
        }
    }

    #warnOnce(error: unknown): void
    {
        if (this.#warnedOnce)
        {
            return;
        }
        this.#warnedOnce = true;
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[azerothjs/logger] file sink write failed (dropping lines): ${ message }\n`);
    }

    #closeQuietly(): void
    {
        if (this.#fd !== null)
        {
            try
            {
                closeSync(this.#fd);
            }
            catch
            {
                // A dead descriptor is already closed for our purposes.
            }
            this.#fd = null;
        }
    }
}

/**
 * A buffered NDJSON file writer. Point it at a FILE to append forever, or at a FOLDER
 * (trailing slash, or an existing directory) for day-named files with size rotation
 * and retention. Use it as the logger's `stream` to keep the fused fast path:
 *
 * @example
 * ```ts
 * const log = createLogger({ stream: fileStream('logs/') });
 * ```
 */
export function fileStream(target: string, options: FileStreamOptions = {}): FileStream
{
    return new BufferedFileStream(target, options);
}

/**
 * The record-level form of {@link fileStream}, for composing with other sinks via
 * {@link teeSink}. Carries `flush`/`close` so shutdown code can drain it.
 */
export function fileSink(target: string, options: FileStreamOptions = {}): FileSink
{
    const stream = fileStream(target, options);
    const sink = (record: LogRecord): void =>
    {
        stream.write(ndjsonLine(record));
    };
    return Object.assign(sink, {
        stream,
        flush: (): void => stream.flush(),
        close: (): void => stream.close(),
        get dropped(): number
        {
            return stream.dropped;
        }
    });
}

/**
 * Fans one record out to several sinks - pretty console for eyes plus an NDJSON file
 * for the permanent record is the canonical pair. A throwing sink is isolated: the
 * others still receive the record, per the logging-never-breaks-the-system doctrine.
 *
 * @example
 * ```ts
 * const log = createLogger({ sink: teeSink(prettySink(), fileSink('logs/')) });
 * ```
 */
export function teeSink(...sinks: LogSink[]): LogSink
{
    return (record: LogRecord): void =>
    {
        for (const sink of sinks)
        {
            try
            {
                sink(record);
            }
            catch
            {
                // One broken destination must not silence the others.
            }
        }
    };
}
