// The devtools event surface: signals, effects, and memos report
// creation, disposal, runs, and writes to a single module-level hook when
// one is installed. The design constraint is the OFF cost: every
// instrumentation point is one `debugId !== 0 && devtoolsHook` check (a
// number compare that is constant-false for nodes created while no hook
// was installed), so production pays nothing measurable.
//
// Nodes created BEFORE a hook is installed have no id and stay invisible
// to it - install devtools before mounting (the documented dev flow), the
// same ordering the error overlay uses.
//
// Edges (who subscribes to whom) are deliberately NOT evented in v1: link
// maintenance is the hottest path in the framework, and the questions
// devtools answer first - what is alive, what runs, how often, after which
// write - fall out of these four events.

/** A node announcement: identity, kind, optional debug name. */
export interface DevtoolsNode
{
    id: number;
    kind: 'signal' | 'effect' | 'memo';
    name?: string;
}

/** The receiver devtools implementations register. */
export interface DevtoolsHook
{
    /** A reactive node came into existence. */
    created(node: DevtoolsNode): void;

    /** The node was disposed (effects/memos; signals are GC-managed). */
    disposed(id: number): void;

    /** An effect's body ran / a memo recomputed. */
    run(id: number): void;

    /** A signal's value actually changed (post-equals). */
    write(id: number): void;
}

/**
 * The active hook, or null. Instrumentation points read this directly;
 * keep it a plain module binding so the off-path is one load + compare.
 *
 * @internal
 */
export let devtoolsHook: DevtoolsHook | null = null;

/** @internal */
let idCounter = 0;

/**
 * Allocates a devtools node id. Only called when a hook is installed at
 * node creation; 0 means "untracked node" everywhere.
 *
 * @internal
 */
export function nextDevtoolsId(): number
{
    return ++idCounter;
}

/**
 * Installs a devtools hook, returning an unregister function that restores
 * the previous one. Install BEFORE mounting - nodes created earlier carry
 * no id and stay invisible.
 *
 * @example
 * ```ts
 * const uninstall = setDevtoolsHook({
 *     created: (node) => console.log('created', node),
 *     disposed: (id) => console.log('disposed', id),
 *     run: (id) => console.log('run', id),
 *     write: (id) => console.log('write', id)
 * });
 * // later:
 * uninstall();
 * ```
 */
export function setDevtoolsHook(hook: DevtoolsHook): () => void
{
    const previous = devtoolsHook;
    devtoolsHook = hook;
    return (): void =>
    {
        devtoolsHook = previous;
    };
}
