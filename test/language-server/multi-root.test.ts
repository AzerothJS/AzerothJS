// Item 6: multi-root routing. startServer keeps one AzerothLanguageService per
// workspace root (a Map keyed by absolute root path) and routes each document to
// the service whose root is its longest-matching prefix. handlers.test.ts covers
// the single-root wiring; this file proves the routing itself - that two folders
// open two independent services, so a symbol that exists only in one root's
// project resolves for that root's document and nowhere else. It also exercises
// onDidChangeWorkspaceFolders adding a third root and tolerating a removal.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToUri } from '@azerothjs/language-service';
// Import the server source directly (same reasoning as handlers.test.ts): there
// is no vitest alias for @azerothjs/language-server, so the package specifier
// would resolve to its possibly-stale dist.
import { startServer } from '../../packages/language-server/src/server.ts';
import { makeMockConnection, at, type Captured } from './_mock-connection.ts';

const FIXTURES = path.join(process.cwd(), 'test', 'language-server', 'fixtures');

interface Fixture
{
    root: string;
    rootUri: string;
    docPath: string;
    docUri: string;
    docText: string;
}

/** Builds a fixture descriptor for `<root>/<docName>`. */
function fixture(rootName: string, docName: string): Fixture
{
    const root = path.join(FIXTURES, rootName);
    const docPath = path.join(root, docName);
    return {
        root,
        rootUri: pathToUri(root),
        docPath,
        docUri: pathToUri(docPath),
        docText: readFileSync(docPath, 'utf8')
    };
}

// Root A has `Modal` (a component symbol defined only in combined/), root B is a
// type-error fixture, root C is a clean fixture added later via the folder-change
// notification.
const ROOT_A = fixture('combined', 'uses.azeroth');
const ROOT_B = fixture('errors', 'bad.azeroth');
const ROOT_C = fixture('clean', 'ok.azeroth');

/** Opens `fix`'s document through the captured document-sync registrar. */
function open(captured: Captured, fix: Fixture): void
{
    captured.onDidOpenTextDocument?.({
        textDocument: { uri: fix.docUri, languageId: 'azeroth', version: 1, text: fix.docText }
    });
}

/** Diagnostics published for `uri` (the last payload wins per open/refresh). */
function diagnosticsFor(captured: Captured, uri: string): unknown[]
{
    const payloads = captured.diagnostics.filter(d => d.uri === uri);
    return payloads.length > 0 ? payloads[payloads.length - 1].diagnostics : [];
}

/** A definition location's uri sits inside `root` when routing picked that root. */
function resolvesInto(defs: unknown, root: string): boolean
{
    const rootUri = pathToUri(root);
    return Array.isArray(defs) && defs.some(d => typeof (d as { uri?: string }).uri === 'string'
        && (d as { uri: string }).uri.startsWith(rootUri));
}

describe('startServer - multi-root routing', () =>
{
    // Two real TS programs over two roots: slow under full-suite CPU contention,
    // so it gets a generous timeout (it is fast in isolation).
    it('routes two folders to two independent services', { timeout: 30000 }, () =>
    {
        const { connection, captured } = makeMockConnection();
        startServer(connection as never);

        // workspaceFolders capability must be on for the folder-change registrar
        // to install; both roots are registered here (not just the first).
        captured.onInitialize?.({
            capabilities: { workspace: { configuration: true, workspaceFolders: true } },
            workspaceFolders: [
                { uri: ROOT_A.rootUri, name: 'combined' },
                { uri: ROOT_B.rootUri, name: 'errors' }
            ]
        });
        captured.onInitialized?.({});

        open(captured, ROOT_A);
        open(captured, ROOT_B);

        // Core assertion: `<Modal>` is defined only in combined/ (root A). It
        // resolves into root A's directory, proving A's document routed to A's
        // service - a service anchored at root B could not resolve Modal.
        const defs = captured.onDefinition?.({
            textDocument: { uri: ROOT_A.docUri },
            position: at(ROOT_A.docText, '<Modal', 1)
        });
        expect(resolvesInto(defs, ROOT_A.root)).toBe(true);

        // And root B's document, routed to its own service, surfaces the type
        // error in bad.azeroth (string assigned to number) - independent of A.
        const bDiags = diagnosticsFor(captured, ROOT_B.docUri);
        expect(bDiags.length).toBeGreaterThan(0);

        // Root A, routed to its own service, does NOT carry root B's type error,
        // so the two roots produced independent diagnostics. (Asserting B's
        // specific error is absent rather than "A has zero diagnostics" keeps
        // this robust to incidental/transient diagnostics under full-suite load.)
        const aDiags = diagnosticsFor(captured, ROOT_A.docUri);
        expect(aDiags.some(d => /not assignable to type 'number'/.test(d.message))).toBe(false);
    });

    it('adds a root via onDidChangeWorkspaceFolders and tolerates removal', { timeout: 30000 }, () =>
    {
        const { connection, captured } = makeMockConnection();
        startServer(connection as never);

        captured.onInitialize?.({
            capabilities: { workspace: { configuration: true, workspaceFolders: true } },
            workspaceFolders: [{ uri: ROOT_A.rootUri, name: 'combined' }]
        });
        captured.onInitialized?.({});

        // Simulate the client adding root C and removing root A.
        captured.onDidChangeWorkspaceFolders?.({
            added: [{ uri: ROOT_C.rootUri, name: 'clean' }],
            removed: [{ uri: ROOT_A.rootUri, name: 'combined' }]
        });

        open(captured, ROOT_C);

        // The newly added root's clean document resolves with no errors, showing
        // its service was registered by the folder-change notification.
        expect(diagnosticsFor(captured, ROOT_C.docUri).length).toBe(0);

        // Removing root A must not wedge the server: opening a doc still routes
        // (serviceFor falls back to a service anchored at the file's directory).
        open(captured, ROOT_A);
        expect(() => captured.onDefinition?.({
            textDocument: { uri: ROOT_A.docUri },
            position: at(ROOT_A.docText, '<Modal', 1)
        })).not.toThrow();
    });

    // The monorepo case: the editor opens the repo PARENT (which has no tsconfig
    // of its own) while the real projects - combined/, errors/ - live one level
    // down, each with its own tsconfig. Every file must still resolve against its
    // OWN nearest project, not the tsconfig-less workspace root.
    it('routes sub-package files to their own nearest tsconfig under a tsconfig-less parent root', { timeout: 30000 }, () =>
    {
        const { connection, captured } = makeMockConnection();
        startServer(connection as never);

        // The single workspace root is FIXTURES itself - the parent. It has no
        // tsconfig.json; only combined/ and errors/ (one level down) do.
        captured.onInitialize?.({
            capabilities: { workspace: { configuration: true, workspaceFolders: true } },
            workspaceFolders: [{ uri: pathToUri(FIXTURES), name: 'monorepo' }]
        });
        captured.onInitialized?.({});

        open(captured, ROOT_A);
        open(captured, ROOT_B);

        // combined/uses.azeroth routed to combined/'s project: <Modal> resolves
        // there. Anchored at the empty parent it could not see combined's types.
        const defs = captured.onDefinition?.({
            textDocument: { uri: ROOT_A.docUri },
            position: at(ROOT_A.docText, '<Modal', 1)
        });
        expect(resolvesInto(defs, ROOT_A.root)).toBe(true);

        // errors/bad.azeroth routed to errors/'s strict project: its type error
        // surfaces. Against the parent's empty config it would not - so the error
        // appearing proves the file used its own nearest tsconfig.
        const bDiags = diagnosticsFor(captured, ROOT_B.docUri);
        expect(bDiags.some(d => /not assignable to type 'number'/.test(d.message))).toBe(true);
    });
});
