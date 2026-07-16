// An ESLint processor that makes `.azeroth` a first-class lint target.
//
// A `.azeroth` file is not valid TypeScript on its own (it has component/markup syntax), so it can't be
// fed to a TS parser directly. Rather than invent a second parser, this processor reuses the COMPILER's
// projection - `generateVirtualCode` lowers the `.azeroth` source to the same virtual TypeScript module
// every other tool consumes, with a byte-exact `CodeMapping` back to the original. ESLint lints that
// virtual TS with the project's normal rules (core + `@typescript-eslint`), and `postprocess` translates
// every message and autofix back to original `.azeroth` positions through the mapping. So:
//   - the compiler stays the single source of truth (no duplicated parsing/lowering here);
//   - the projection is plain TypeScript (markup is lowered to `h(...)` calls), so there are NO JSX/TSX
//     assumptions anywhere - the virtual block is a `.ts` file, not `.tsx`;
//   - a diagnostic whose location falls in generated scaffolding (no original origin) is DROPPED, so no
//     message or fix ever points into virtual code;
//   - the compiler's own reactivity diagnostics (self-write-in-effect, constant-derived, inert-effect,
//     handler-not-function, ...) are merged into the SAME list, so the developer sees one unified report.

import type { Linter, Rule } from 'eslint';
import { generateVirtualCode, diagnoseModule, lintSource, parseModule, type CodeMapping } from '@azerothjs/compiler';
import { registerDocument } from './project-pool.ts';

/** What preprocess stashes for postprocess, keyed by the `.azeroth` file name. */
interface Projection
{
    /** The original `.azeroth` source. */
    source: string;

    /** The projection's offset mapping, or null when the source could not be projected. */
    mapping: CodeMapping | null;

    /** The virtual TypeScript text (for verifying a fix targets byte-identical source). */
    virtual: string;

    /** Line-start offsets of the original source (for offset -> line/column). */
    sourceStarts: number[];

    /** Line-start offsets of the virtual TypeScript (for ESLint line/column -> offset). */
    virtualStarts: number[];
}

// ESLint drives a file synchronously: preprocess, then lint each block, then postprocess. Keying by file
// name lets postprocess recover the projection the messages were produced against.
const projections = new Map<string, Projection>();

/** Offsets at which each line begins (index 0 = line 1). */
function lineStarts(text: string): number[]
{
    const starts = [0];
    for (let i = 0; i < text.length; i++)
    {
        if (text.charCodeAt(i) === 10)
        {
            starts.push(i + 1);
        }
    }
    return starts;
}

/** ESLint 1-based line/column -> absolute offset. */
function offsetAt(starts: number[], line: number, column: number): number
{
    return (starts[line - 1] ?? 0) + (column - 1);
}

/** Absolute offset -> ESLint 1-based line/column (binary search for the containing line). */
function locationAt(starts: number[], offset: number): { line: number; column: number }
{
    let lo = 0;
    let hi = starts.length - 1;
    let idx = 0;
    while (lo <= hi)
    {
        const mid = (lo + hi) >> 1;
        if ((starts[mid] ?? 0) <= offset)
        {
            idx = mid;
            lo = mid + 1;
        }
        else
        {
            hi = mid - 1;
        }
    }
    return { line: idx + 1, column: offset - (starts[idx] ?? 0) + 1 };
}

/**
 * Translates one fix from virtual to original coordinates, or null when it can't be represented
 * faithfully in the source. `fix.range` is a `[start, end)` pair of offsets into the virtual block text,
 * which IS the generated module - so they are generated offsets.
 *
 * Both endpoints are mapped independently (not via `toOriginalRange`, which demands a single segment and
 * so rejects a token like `==` that abuts a segment boundary). The fix is accepted only when the mapped
 * source span is byte-for-byte identical to the virtual span it replaces - that guarantees the autofix
 * rewrites exactly the text the rule intended, never reaching into generated scaffolding. An insertion
 * (zero-width range) maps cleanly too: both endpoints land on the same source offset.
 */
function mapFix(fix: Rule.Fix, projection: Projection): Rule.Fix | null
{
    const mapping = projection.mapping;
    if (mapping === null)
    {
        return null;
    }
    const start = mapping.toOriginal(fix.range[0]);
    const end = mapping.toOriginal(fix.range[1]);
    if (start === null || end === null || end < start)
    {
        return null;
    }
    if (projection.source.slice(start, end) !== projection.virtual.slice(fix.range[0], fix.range[1]))
    {
        return null;
    }
    return { range: [start, end], text: fix.text };
}

/**
 * Translates one lint message from the virtual module back to the original `.azeroth` file, or null when
 * its start lands in generated scaffolding (no original origin) - such a message is about code the user
 * never wrote, so it is dropped rather than mapped to a misleading location.
 */
function mapMessage(message: Linter.LintMessage, projection: Projection): Linter.LintMessage | null
{
    const mapping = projection.mapping;
    if (mapping === null)
    {
        return null;
    }
    const virtualStart = offsetAt(projection.virtualStarts, message.line, message.column);
    const startOffset = mapping.toOriginal(virtualStart);
    if (startOffset === null)
    {
        return null;
    }
    // Round-trip guard. `toOriginal` accepts an offset that merely TOUCHES a user segment's exclusive end
    // (correct for a caret), so a violation reported on generated scaffolding that abuts a user segment
    // maps to a non-null source offset one char past the user's text - a message about code the user never
    // wrote, surfacing at the wrong place. A genuine in-user-code offset round-trips to itself; a
    // scaffolding-abutting one does not. Drop the latter.
    if (mapping.toGenerated(startOffset) !== virtualStart)
    {
        return null;
    }
    const start = locationAt(projection.sourceStarts, startOffset);

    // Map the end when present; if the end falls in scaffolding, collapse to the start (still a valid,
    // if zero-width, range) rather than dropping an otherwise-mappable message.
    let endLine = start.line;
    let endColumn = start.column;
    if (message.endLine !== undefined && message.endColumn !== undefined)
    {
        const endOffset = mapping.toOriginal(offsetAt(projection.virtualStarts, message.endLine, message.endColumn));
        if (endOffset !== null)
        {
            const end = locationAt(projection.sourceStarts, endOffset);
            endLine = end.line;
            endColumn = end.column;
        }
    }

    const mapped: Linter.LintMessage = { ...message, line: start.line, column: start.column, endLine, endColumn };

    // An autofix that can't be mapped back is dropped (the message stays, just non-fixable) so ESLint
    // never rewrites the original file from a range computed against generated code.
    if (message.fix !== undefined)
    {
        const fix = mapFix(message.fix, projection);
        if (fix === null)
        {
            delete mapped.fix;
        }
        else
        {
            mapped.fix = fix;
        }
    }

    // Suggestions carry their own fixes; keep only those that translate cleanly.
    if (message.suggestions !== undefined)
    {
        const suggestions = [];
        for (const suggestion of message.suggestions)
        {
            const fix = mapFix(suggestion.fix, projection);
            if (fix !== null)
            {
                suggestions.push({ ...suggestion, fix });
            }
        }
        mapped.suggestions = suggestions;
    }

    return mapped;
}

/**
 * Source spans of every `state` declaration NAME. The projection lowers `state x = v` to `let x = ...`
 * (so reads aren't flow-narrowed to the initializer), and a `state` that is never reassigned in the
 * component therefore looks like a `prefer-const` candidate in the virtual TypeScript - but turning it
 * into `const` would break the reactive lowering. So `prefer-const` runs (it has a real signal on a
 * genuine user `let`), and messages that land on a `state` name are dropped here. A safe empty list on
 * any parse failure.
 */
function stateNameRanges(source: string): Array<[number, number]>
{
    const ranges: Array<[number, number]> = [];
    try
    {
        for (const item of parseModule(source).items)
        {
            if (item.kind !== 'component')
            {
                continue;
            }
            for (const bodyItem of item.body)
            {
                if (bodyItem.kind === 'state')
                {
                    ranges.push([bodyItem.nameStart, bodyItem.nameEnd]);
                }
            }
        }
    }
    catch
    {
        // Malformed module: no ranges (prefer-const will simply not be filtered).
    }
    return ranges;
}

/** True when `offset` falls within any `state` name span (so a prefer-const hit there is a false positive). */
function offsetInRanges(offset: number, ranges: Array<[number, number]>): boolean
{
    for (const [start, end] of ranges)
    {
        if (offset >= start && offset < end)
        {
            return true;
        }
    }
    return false;
}

/** The compiler's own `.azeroth` diagnostics as ESLint messages, located in the original source. */
function compilerDiagnostics(projection: Projection): Linter.LintMessage[]
{
    if (projection.source === '')
    {
        return [];
    }
    let diagnostics;
    try
    {
        diagnostics = diagnoseModule(projection.source);
    }
    catch
    {
        // A malformed module surfaces its parse error through the compiler/editor, not here.
        return [];
    }
    return diagnostics.map((diagnostic) =>
    {
        const start = locationAt(projection.sourceStarts, diagnostic.start);
        const end = locationAt(projection.sourceStarts, diagnostic.end);
        return {
            ruleId: diagnostic.code,
            severity: diagnostic.severity === 'error' ? 2 : 1,
            message: diagnostic.message,
            line: start.line,
            column: start.column,
            endLine: end.line,
            endColumn: end.column
        } satisfies Linter.LintMessage;
    });
}

/**
 * The compiler's markup lint (duplicate-attr, event-case, interpolation-spacing, ...) as ESLint
 * messages. The rules live compiler-side because they concern markup PUNCTUATION the projection
 * lowers away - no rule running on the virtual TypeScript could ever see an interpolation's braces.
 * Findings (and their fixes) already carry ORIGINAL source coordinates, which is exactly the space
 * postprocess returns messages in, so unlike the virtual-block messages they need no mapping - a
 * carried fix is forwarded as-is and `eslint --fix` rewrites the `.azeroth` source directly.
 */
function markupLint(projection: Projection): Linter.LintMessage[]
{
    if (projection.source === '')
    {
        return [];
    }
    let findings;
    try
    {
        findings = lintSource(projection.source);
    }
    catch
    {
        // Malformed markup: the parse error is reported by the compiler/editor, not lint.
        return [];
    }
    return findings.map((finding) =>
    {
        const start = locationAt(projection.sourceStarts, finding.start);
        const end = locationAt(projection.sourceStarts, finding.end);
        const message: Linter.LintMessage = {
            ruleId: finding.code,
            severity: 1,
            message: finding.message,
            line: start.line,
            column: start.column,
            endLine: end.line,
            endColumn: end.column
        };
        if (finding.fix !== undefined)
        {
            message.fix = { range: finding.fix.range, text: finding.fix.text };
        }
        return message;
    });
}

export const azerothProcessor: Linter.Processor =
{
    meta: { name: '@azerothjs/eslint-plugin/azeroth', version: '0.6.0-beta.1' },
    supportsAutofix: true,

    preprocess(text: string, filename: string): Linter.ProcessorFile[]
    {
        // Register the file in the shared AzerothProject so its virtual twin joins the program BEFORE the
        // parser runs - that program is what gives the virtual block real types (the type-aware path).
        // Best-effort: a project-setup failure must never break linting, so it falls back to syntactic.
        try
        {
            registerDocument(filename, text);
        }
        catch
        {
            // No project (e.g. no tsconfig in range): the parser degrades to a syntactic parse.
        }

        let mapping: CodeMapping | null = null;
        let virtual = '';
        try
        {
            const projected = generateVirtualCode(text);
            virtual = projected.code;
            mapping = projected.mapping;
        }
        catch
        {
            // Projection failed (malformed `.azeroth`): lint nothing, but still reach postprocess so the
            // compiler's located diagnostics are surfaced (the editor reports the parse error itself).
        }
        projections.set(filename, {
            source: text,
            mapping,
            virtual,
            sourceStarts: lineStarts(text),
            virtualStarts: lineStarts(virtual)
        });
        // The block is `.ts` (the projection is plain TypeScript, no JSX) so the project's `.ts` rules and
        // parser apply to it. An empty block when projection failed still parses cleanly and yields nothing.
        return [{ text: virtual, filename: '0.ts' }];
    },

    postprocess(messages: Linter.LintMessage[][], filename: string): Linter.LintMessage[]
    {
        const projection = projections.get(filename);
        projections.delete(filename);
        if (projection === undefined)
        {
            return [];
        }

        const out: Linter.LintMessage[] = [];
        // `state x` projects to `let x`; a never-reassigned state would draw a spurious prefer-const. Drop
        // those (computed once); a real user `let` still gets flagged.
        const stateRanges = stateNameRanges(projection.source);
        // ESLint/TS rules ran on the virtual module: map each surviving message back to the source.
        for (const message of messages[0] ?? [])
        {
            const mapped = mapMessage(message, projection);
            if (mapped === null)
            {
                continue;
            }
            if (mapped.ruleId === 'prefer-const'
                && offsetInRanges(offsetAt(projection.sourceStarts, mapped.line, mapped.column), stateRanges))
            {
                continue;
            }
            out.push(mapped);
        }
        // Unify the compiler's reactivity diagnostics and markup lint into the same list.
        out.push(...compilerDiagnostics(projection));
        out.push(...markupLint(projection));
        return out;
    }
};
