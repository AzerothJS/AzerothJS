// Minimal structural AST types and helpers shared by the rules. The rules
// are deliberately SYNTACTIC: they track signals from
// `const [x, setX] = createSignal(...)` destructuring by name, the same
// approach eslint-plugin-solid takes. That keeps them parser-agnostic (no
// type-services project wiring for consumers) at the cost of not seeing
// through aliases or imports-as - the trade is documented per rule.

/** The slice of ESTree the rules touch, structurally typed. */
export interface AstNode
{
    type: string;
    parent?: AstNode;
    [key: string]: unknown;
}

/** A `name` carrier (Identifier). */
export interface IdentifierNode extends AstNode
{
    type: 'Identifier';
    name: string;
}

/** A call with a callee and arguments. */
export interface CallNode extends AstNode
{
    type: 'CallExpression';
    callee: AstNode;
    arguments: AstNode[];
}

/**
 * True when `node` is an Identifier with the given name. Accepts `null` because
 * ESTree uses `null` (not `undefined`) for absent optional slots - e.g. an
 * ArrayPattern hole or a `for (const x of ...)` declarator's `init`.
 */
export function isIdentifier(node: AstNode | null | undefined, name?: string): node is IdentifierNode
{
    return node !== undefined && node !== null && node.type === 'Identifier'
        && (name === undefined || (node as IdentifierNode).name === name);
}

/** True when `node` is a call of the named identifier: `name(...)`. */
export function isCallTo(node: AstNode | null | undefined, name: string): node is CallNode
{
    return node !== undefined && node !== null && node.type === 'CallExpression'
        && isIdentifier((node as CallNode).callee, name);
}

/** A function expression of any flavor. */
export function isFunctionNode(node: AstNode | null | undefined): boolean
{
    return node !== undefined && node !== null && (
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'FunctionExpression' ||
        node.type === 'FunctionDeclaration'
    );
}

/**
 * Walks ancestors from `node` upward, returning the first one matching
 * `predicate`, stopping (exclusive) at `boundary`.
 */
export function findAncestor(
    node: AstNode,
    predicate: (ancestor: AstNode) => boolean,
    boundary?: AstNode
): AstNode | null
{
    let current = node.parent;
    while (current !== undefined && current !== null && current !== boundary)
    {
        if (predicate(current))
        {
            return current;
        }
        current = current.parent;
    }
    return null;
}

/**
 * Collects the getter->setter pairs declared in the file via
 * `const [get, set] = createSignal(...)`. Keyed both ways for the rules'
 * lookups.
 */
export interface SignalPairs
{
    /** setter name -> getter name */
    getterOf: Map<string, string>;

    /** getter names */
    getters: Set<string>;
}

/** Records a `const [g, s] = createSignal(...)` declarator into `pairs`. */
export function collectSignalPair(declarator: AstNode, pairs: SignalPairs): void
{
    const init = declarator.init as AstNode | undefined;
    if (!isCallTo(init, 'createSignal'))
    {
        return;
    }
    const id = declarator.id as AstNode | undefined;
    if (id === undefined || id.type !== 'ArrayPattern')
    {
        return;
    }
    const elements = id.elements as (AstNode | null)[];
    const getter = elements[0];
    const setter = elements[1];
    if (getter !== null && setter !== null && isIdentifier(getter) && isIdentifier(setter))
    {
        pairs.getterOf.set((setter as IdentifierNode).name, (getter as IdentifierNode).name);
        pairs.getters.add((getter as IdentifierNode).name);
    }
}
