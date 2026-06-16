// Call hierarchy across files. A helper function lives in its own `.azeroth`
// component and is invoked from a sibling's markup expression; preparing the
// item on the helper and asking for its callers must reach back across the file
// boundary, with every span mapped from the virtual module to original source.
// Both the helper declaration and the call site sit in verbatim script /
// expression holes, so they map cleanly (a span straddling generated scaffolding
// would be dropped, exactly as in the symbols providers).

import { describe, it, expect, beforeEach } from 'vitest';
import { AzerothLanguageService, LineIndex, pathToUri, type Position } from '@azerothjs/language-service';
import path from 'node:path';

const ROOT = process.cwd();

function at(source: string, needle: string, offsetInNeedle = 0): Position
{
    return new LineIndex(source).positionAt(source.indexOf(needle) + offsetInNeedle);
}

// Exports a plain helper (verbatim script) plus a component that returns markup.
const FORMAT = [
    'export function formatGold(copper: number): string',
    '{',
    '    return `${ copper } c`;',
    '}',
    'export default function Wallet(props: { copper: number })',
    '{',
    '    return <span>{formatGold(props.copper)}</span>;',
    '}'
].join('\n');

// A consumer that imports and calls the helper from a markup expression.
const CONSUMER = [
    "import { formatGold } from './Format.azeroth';",
    'export default function Price(props: { copper: number })',
    '{',
    '    return <b>{formatGold(props.copper)}</b>;',
    '}'
].join('\n');

let ls: AzerothLanguageService;
const formatUri = pathToUri(path.join(ROOT, 'Format.azeroth'));
const consumerUri = pathToUri(path.join(ROOT, 'Price.azeroth'));

beforeEach(() =>
{
    ls = new AzerothLanguageService(ROOT);
    ls.didOpen(formatUri, FORMAT);
    ls.didOpen(consumerUri, CONSUMER);
});

describe('call hierarchy', () =>
{
    it('prepares an item on the helper declaration, mapped to source', () =>
    {
        const items = ls.getCallHierarchyPrepare(formatUri, at(FORMAT, 'formatGold', 1));
        expect(items.length).toBeGreaterThan(0);
        const item = items.find(i => i.name === 'formatGold');
        expect(item).toBeTruthy();
        expect(item!.uri).toBe(formatUri);
        // The selection range lands on the declaration name in the original file.
        const line = FORMAT.split('\n')[item!.selectionRange.start.line];
        expect(line).toContain('formatGold');
        // `data` round-trips the source URI + offset so the follow-up call routes.
        expect(item!.data?.uri).toBe(formatUri);
    });

    it('reports an incoming call from the consuming component', () =>
    {
        const [item] = ls.getCallHierarchyPrepare(formatUri, at(FORMAT, 'formatGold', 1));
        expect(item).toBeTruthy();
        const incoming = ls.getIncomingCalls(item);
        const fromConsumer = incoming.find(c => c.from.uri === consumerUri);
        expect(fromConsumer).toBeTruthy();
        expect(fromConsumer!.fromRanges.length).toBeGreaterThan(0);
        // The call-site range points at the invocation in the consumer's markup.
        const line = CONSUMER.split('\n')[fromConsumer!.fromRanges[0].start.line];
        expect(line).toContain('formatGold');
    });

    it('reports an outgoing call from a caller to the helper', () =>
    {
        // Prepare on the consumer's own function, then walk its callees.
        const [caller] = ls.getCallHierarchyPrepare(consumerUri, at(CONSUMER, 'function Price', 'function '.length));
        expect(caller).toBeTruthy();
        const outgoing = ls.getOutgoingCalls(caller);
        const toHelper = outgoing.find(c => c.to.name === 'formatGold');
        expect(toHelper).toBeTruthy();
        expect(toHelper!.to.uri).toBe(formatUri);
    });
});
