// Tests for the documentation-extraction seed: it must render a markdown API
// reference for the component a `.azeroth` file exports, with a heading, the
// component's own doc comment, and a **Props** table read from the REAL props
// type (names, optionality, and per-prop JSDoc). Mirrors the
// language-service.test.ts harness: an in-memory document resolved against the
// repo tsconfig, queried through the live service.

import { describe, it, expect, beforeEach } from 'vitest';
import { AzerothLanguageService, pathToUri } from '@azerothjs/language-service';
import { generateComponentDocs } from '../../packages/language-service/src/docgen.ts';
import path from 'node:path';

const ROOT = process.cwd();

const GREETING = [
    '/** Greets a visitor by name. */',
    'export default function Greeting(props: { name: string; greeting?: string }) {',
    '    return <p>{props.greeting ?? \'Hi\'}, {props.name}!</p>;',
    '}'
].join('\n');

const TYPED = [
    'interface BadgeProps {',
    '    /** The label shown on the badge. */',
    '    label: string;',
    '    /** When set, dims the badge. */',
    '    muted?: boolean;',
    '}',
    'export default function Badge(props: BadgeProps) {',
    '    return <span>{props.label}</span>;',
    '}'
].join('\n');

let ls: AzerothLanguageService;
const uri = pathToUri(path.join(ROOT, 'Greeting.azeroth'));

beforeEach(() =>
{
    ls = new AzerothLanguageService(ROOT);
    ls.didOpen(uri, GREETING);
});

describe('generateComponentDocs', () =>
{
    it('renders the component name as a heading and its doc comment', () =>
    {
        const md = generateComponentDocs(ls, uri);
        expect(md).toContain('# Greeting');
        expect(md).toContain('Greets a visitor by name.');
    });

    it('lists each prop with its optional marker in the props table', () =>
    {
        const md = generateComponentDocs(ls, uri);
        expect(md).toContain('| name |');
        expect(md).toContain('| greeting |');
        const greetingRow = md.split('\n').find(line => line.startsWith('| greeting |'));
        const nameRow = md.split('\n').find(line => line.startsWith('| name |'));
        // `greeting?` is optional, `name` is required.
        expect(greetingRow).toContain('Yes');
        expect(nameRow).toContain('No');
    });

    it('surfaces a prop\'s JSDoc summary from a named props interface', () =>
    {
        const u = uri.replace('Greeting', 'Badge');
        ls.didOpen(u, TYPED);
        const md = generateComponentDocs(ls, u);
        expect(md).toContain('# Badge');
        expect(md).toContain('| label |');
        expect(md).toContain('The label shown on the badge.');
        expect(md).toContain('When set, dims the badge.');
    });

    it('states when a component takes no props', () =>
    {
        const u = uri.replace('Greeting', 'Empty');
        ls.didOpen(u, 'export default function Empty() {\n    return <p>hi</p>;\n}');
        const md = generateComponentDocs(ls, u);
        expect(md).toContain('# Empty');
        expect(md).toContain('no props');
    });

    it('returns a best-effort heading for an unknown document (never throws)', () =>
    {
        const u = uri.replace('Greeting', 'Missing');
        const md = generateComponentDocs(ls, u);
        expect(md).toContain('# Missing');
    });
});
