// Offset <-> line/character conversion. The compiler and TypeScript both work
// in byte offsets; LSP speaks line/character. A LineIndex precomputes the start
// offset of every line so conversions in either direction are a binary search,
// which matters when translating the many ranges a "find references" returns.

import type { Position, Range } from './protocol.ts';

/**
 * Precomputed line-start offsets for a source string.
 *
 * @example
 * ```ts
 * const idx = new LineIndex('a\nbc');
 * idx.positionAt(3);            // { line: 1, character: 1 }
 * idx.offsetAt({ line: 1, character: 1 }); // 3
 * ```
 */
export class LineIndex
{
    private readonly lineStarts: number[];

    constructor(private readonly text: string)
    {
        this.lineStarts = [0];
        for (let i = 0; i < text.length; i++)
        {
            if (text[i] === '\n')
            {
                this.lineStarts.push(i + 1);
            }
        }
    }

    /** Converts a byte offset to a zero-based position. */
    public positionAt(offset: number): Position
    {
        const clamped = Math.max(0, Math.min(offset, this.text.length));
        let lo = 0;
        let hi = this.lineStarts.length - 1;
        while (lo < hi)
        {
            const mid = (lo + hi + 1) >> 1;
            if (this.lineStarts[mid] <= clamped)
            {
                lo = mid;
            }
            else
            {
                hi = mid - 1;
            }
        }
        return { line: lo, character: clamped - this.lineStarts[lo] };
    }

    /** Converts a zero-based position to a byte offset. */
    public offsetAt(position: Position): number
    {
        if (position.line < 0)
        {
            return 0;
        }
        if (position.line >= this.lineStarts.length)
        {
            return this.text.length;
        }
        const lineStart = this.lineStarts[position.line];
        const nextLine = position.line + 1 < this.lineStarts.length
            ? this.lineStarts[position.line + 1]
            : this.text.length + 1;
        return Math.min(lineStart + Math.max(0, position.character), nextLine - 1);
    }

    /** Converts a `[start, end)` offset span to a Range. */
    public rangeAt(start: number, end: number): Range
    {
        return { start: this.positionAt(start), end: this.positionAt(end) };
    }

    /** Total line count. */
    public get lineCount(): number
    {
        return this.lineStarts.length;
    }
}
