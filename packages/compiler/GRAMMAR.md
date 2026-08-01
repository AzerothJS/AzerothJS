# The `.azeroth` grammar

NORMATIVE for the 1.x train. This document specifies the syntax of `.azeroth` source
files: what the compiler recognizes, how every ambiguity is resolved, and what is
deliberately out of scope. The compiler in this package is the reference
implementation; where its behavior and this document disagree, one of the two has a
defect - file it. Syntax evolution across versions is governed by the syntax-stability
policy (see the compiler README).

## 1. Model

A `.azeroth` file is a TypeScript module augmented with ONE construct: the
`component` declaration. Everything outside a component declaration is **opaque
TypeScript** - the compiler passes it through verbatim and never interprets it.
Inside a component body, a small set of *shape-gated contextual keywords* introduces
reactive declarations and blocks, and `<`-delimited **markup** may appear in
statement position. All expression interiors (initializers, hole contents, handler
bodies, the props parameter) remain ordinary TypeScript, delegated to the TypeScript
language itself - this grammar never parses inside them.

Parsing is TOTAL: malformed input still produces a module (unrecognized text falls
into opaque regions). The one hard error is malformed markup the parser has committed
to (§6.5).

## 2. Lexical structure

The parser advances through source one *structural unit* at a time. Units:

- **Trivia** - whitespace; `// line` and `/* block */` comments. Transparent: trivia
  never changes disambiguation state.
- **String literals** - `'...'` and `"..."` with `\` escapes.
- **Template literals** - `` `...` `` including nested `${ ... }` substitutions. A
  substitution is scanned as verbatim TypeScript (its braces, strings, and regexes are
  balanced) but is NOT recompiled: markup inside a `${ ... }` is not lowered to render
  calls. Place markup at a hole or the render position, not inside a template string.
- **Regular-expression literals** - `/.../flags`, recognized only in expression
  position (§3); with character-class and escape handling.
- **Numeric literals** - a digit begins a number.
- **Identifiers / words** - `[A-Za-z_$][A-Za-z0-9_$]*`. (ASCII-only in 1.x; Unicode
  identifier characters inside opaque TypeScript are untouched, but *recognized
  words* - keywords, component names, declaration names - are ASCII.)
- **Markup regions** - a `<` in expression position that parses as markup (§3, §6).
- **Punctuators** - everything else, single characters; `(`/`[`/`{` and their
  closers additionally track nesting depth.

## 3. Expression-position disambiguation (normative)

Two characters are ambiguous in a C-family grammar: `/` (divide vs regex) and `<`
(less-than vs markup vs type parameters). Both are resolved by ONE rule keyed on the
previous significant token.

**Expression position** holds when the previous significant token is:

- one of the keywords
  `return typeof instanceof in of do else yield await case delete void new`, or
- one of the punctuators
  `( { [ } , ; : ? = > < & | ! ~ + - * / % ^` - or the start of input.

`}` is included for the block-then-render shape: `effect { ... } <div>...` or
`dispose { ... } <ul>...`, where the markup after a reactive block must read as markup.
The only case this misclassifies - `{obj}<ident`, an object literal compared with `<` and
no space - is nonsensical and does not occur in practice.

After an identifier, a literal, or a closing `)`/`]`, the position is *operator position*:
`/` is division, `<` is less-than. A newline does NOT create expression position (there is
no ASI here): `const x = foo` then a newline then `<div>` reads the `<` as less-than. End
the statement with `;` before markup, or put the markup in a hole / at the render position.

### 3.1 The `/` rule

In expression position, `/` (not followed by `/` or `*`) begins a regular-expression
literal. In operator position it is division.

### 3.2 The `<` rules

A `<` in operator position is always the less-than operator.

A `<` in expression position, followed by `>` or an identifier-start character, is a
**markup candidate**. It resolves in this order:

1. `<>` - always a fragment (§6.2). Never a type-parameter list.
2. `<Ident ...` - probed as a **generic arrow type-parameter list**: if the balanced
   `<...>` region is followed (after trivia) by `(`, whose balanced close is followed
   by `:` (return-type annotation) or `=>`, the `<...>` is the type-parameter list of
   a generic arrow function and NOT markup. Markup can never have this shape
   (`<div>(x)</div>` fails the probe: no `:`/`=>` after the parenthesis).
3. Otherwise the `<` opens **markup**, and the markup parser commits per §6.5.

### 3.3 The TSX rules (author-facing consequences)

`.azeroth` follows the same authoring rules as `.tsx`:

- **No angle-bracket type assertions.** Write `value as Foo`. A `<Foo>value` is read
  as markup, and its missing `</Foo>` is reported as an unclosed tag.
- **Generic arrows: write the trailing comma.** `<T,>(v: T) => v`. A comma-less
  `<T>(v: T) => v` is read as markup and reported as an unclosed `<T>` tag - in every
  position. The trailing comma is required, exactly as in `.tsx`.
- **Type arguments in call position are unaffected**: `foo<Bar>(x)`, `new C<Bar>()`.

## 4. Module grammar

```
Module          := (OpaqueTS | ComponentDecl)*
ComponentDecl   := `component` Identifier TypeParams? ParamClause? Block
TypeParams      := `<` ... balanced ... `>`            // verbatim TS type parameters
ParamClause     := `(` Param? `)`                      // Param is ONE verbatim TS parameter
Block           := `{` ... markup-aware balanced ... `}`
```

- `component` is recognized at statement position in module code. A preceding
  `export` / `export default` remains part of the surrounding opaque region (the
  compiler handles the association; the grammar does not).
- The props parameter is a single ordinary TypeScript parameter - a named parameter
  (`props: T`), a destructuring pattern (`{ a, b = 1 }: T`), with or without inline
  object types. Its interior is TypeScript's, not this grammar's.
- The body braces are **markup-aware**: an apostrophe or brace inside markup text
  (`<p>it's {x}</p>`) does not affect brace balance, because whole markup regions
  are consumed as units (§2).

## 5. Component-body grammar

At the TOP LEVEL of a component body (depth 0, statement position), each item is one
of the following; anything unrecognized is an opaque TypeScript statement run.

```
BodyItem        := ReactiveDecl | EffectBlock | WrapperBlock | Markup | OpaqueTS

ReactiveDecl    := DeclKeyword Identifier ArraySuffix? ( `=` Value )? WithClause? `;`
DeclKeyword     := `state` | `derived` | `deferred`
                 | `resource` | `stream` | `store` | `selector` | `form`
ArraySuffix     := `[` `]`                             // permitted ONLY after a `form` name

EffectBlock     := `effect` WithClause? Block
                 | `effect` `(` Deps `)` ( `(` CallbackParams `)` )? WithClause? Block

WrapperBlock    := (`batch` | `untrack` | `cleanup` | `dispose` | `mount`) Block

WithClause      := `with` `{` ... balanced TS object ... `}`
```

Normative rules:

- **Shape-gating.** A declaration keyword only takes effect when an identifier (the
  declaration name) follows it; otherwise the word is a plain reference -
  `store.get()`, `selector(x)`, and a variable named `state` all parse as ordinary
  TypeScript. `effect(call);` with no following block is a plain call. This is what
  keeps every keyword *contextual*: no word is reserved (§7).
- **No ASI.** A reactive declaration MUST end with an explicit `;`. The terminator
  scan is depth-aware (a `;` inside `(...)`, `[...]`, `{...}`, a string, or markup
  does not terminate) but never infers a terminator from a newline. Rationale: the
  value span feeds the reactive rewrite; a guessed boundary would silently change
  which reads get rewritten.
- **`Value` is a verbatim TypeScript expression span** - never parsed here, may
  contain markup (which is consumed as a unit). The initializer is syntactically
  optional (an omitted `= Value` lowers to the primitive's no-argument form, e.g.
  `state x;` -> `createSignal(undefined)`); always provide one in practice.
- **The two `effect` forms.** Without parentheses: auto-tracked
  (`createEffect`). With an immediate `(` after the keyword: the
  explicit-dependency form - `effect (a, b) (values, prev) with { ... } { body }` -
  where `(Deps)` is a comma-list of dependency expressions and the optional second
  parenthesis names the callback's parameters. Top-level only; the body brace is
  required in both forms.
- **Wrapper blocks** lower to `batch(() => {...})`, `untrack(...)`,
  `onCleanup(...)`, `onRootDispose(...)`, `onMount(...)` respectively. Block required.

### 5.1 The `with { }` clause

`with { ... }` attaches an options object to the declaration or effect to its left.
The clause is recognized by a depth-0 scan of the statement: the word `with` at
nesting depth 0, followed (after trivia) by `{`. A `with` inside the value - in a
string, a nested lambda, an object literal - is at depth > 0 or not the recognized
word, and is never mistaken for the clause.

**TC39 import-attributes note.** ES modules use `import ... with { type: "json" }`.
No collision exists: import statements live at module level, which is opaque
TypeScript (§1) - the `.azeroth` `with` clause exists ONLY inside component bodies,
attached to a reactive declaration's value or an `effect` header. The legacy
`with (obj) { }` *statement* is syntactically excluded in module code (strict mode)
and, inside bodies, is not followed by `{` immediately after the word (it takes a
parenthesis), so the depth-0 rule cannot capture it.

## 6. Markup grammar

```
Markup          := Element | Fragment
Fragment        := `<>` Children `</>`
Element         := `<` TagName Attributes ( `/>` | `>` Children `</` TagName `>` )
TagName         := Identifier ( `.` Identifier )* | `-`-containing HTML name
Children        := ( Element | Fragment | Text | Hole )*
Hole            := `{` ... balanced TS expression ... `}`

Attributes      := ( Attribute | Spread )*
Attribute       := Name
                 | Name `=` StringLiteral
                 | Name `=` `{` ... TS expression ... `}`
Spread          := `{` `...` TS expression `}`
```

- **Component vs element tags**: a tag whose first character is uppercase, or that
  contains a `.` (member path), is a component reference; all others are HTML/SVG
  elements. Built-in components (`Show`, `For`, `Switch`, `Match`, `Portal`,
  `Dynamic`, `Suspense`, `ErrorBoundary`, `Transition`, `Outlet`) are auto-imported.
- **Void elements** (`br`, `img`, `input`, ...) may be written self-closed
  (`<br/>`) or HTML-style (`<br>`); both are childless.
- **Text** carries no expression syntax - an apostrophe in text is text - and is
  normalized in exactly two ways, both HTML's own:
  - **Entities are decoded**: the named set (`&amp;`, `&nbsp;`, ...) plus numeric
    decimal and hex refs (`&#65;`, `&#x42;`). An unrecognized `&foo;` stays literal.
  - **Newline whitespace collapses**: a whitespace-only run containing a newline is
    dropped (so indentation between tags emits no text node), and inside a run that
    has real text each `\s*\n\s*` sequence becomes a single space. Same-line spacing
    is authored spacing and is preserved - `a <b>x</b> c` keeps both spaces.
- **Holes** capture their interior as a RAW TypeScript span; nested markup inside a
  hole is compiled recursively. A hole containing only comments/whitespace is
  dropped.
- **Directive attribute names** are contextual, resolved by the markup layer (they
  are NOT keywords): `class:name={cond}`, `style:prop={value}`, `bind:value={ref}`,
  and `on*` event handlers. A bare attribute (`disabled`) is boolean-true.

### 6.5 Commitment

Once the parser has consumed `<tag ` with markup-only evidence (an opening tag, a
fragment `<>`, a self-close), the region IS markup: a malformation past that point
(unclosed tag, bad attribute) is a **located hard error**, never a silent fallback
to opaque TypeScript. An *uncommitted* failure - e.g. `<T,>` - falls through to
plain TypeScript (that is what makes the trailing-comma spelling reliable, §3.3).

### 6.6 Attribute and props semantics (normative)

These rules define what an element's attributes MEAN, independently of any
implementation. Every conforming compiler and every render mode (template clone,
`h()`, SSR string, hydration) must assign the same meaning to the same program.
The shared vocabulary these rules are written against is the `azerothjs/semantics`
module; the executable form of this section is the cross-mode conformance suite
(`packages/compiler/tests/conformance`), which a conforming implementation must
pass without consulting any other implementation's internals.

**Name domains.** The tag selects the domain of every attribute name on it:

- **Host elements**: a *handler-form* name (`on` followed by any character that is
  not a lowercase letter) denotes the DOM event type `lowercase(name[2..])`;
  `onClick` and `onCLICK` both denote `click`. The REST of the `on*` namespace,
  matched case-insensitively (`onclick`, `once`, `ONCLICK`, `onward-link`), is
  **reserved**: HTML compiles `on*` content attributes into live handlers, so these
  names can neither pass through as attributes safely nor name an event, and a
  program using one is REJECTED (`azeroth/reserved-event-name`; the error carries
  the mechanical camelCase repair). Every name OUTSIDE the `on*` namespace denotes
  the attribute/property verbatim; the language does not validate those against the
  DOM (unknown names pass through, exactly as in HTML).
- **Components**: every attribute name denotes a props-object key, **verbatim** -
  handler form changes only the VALUE rule (below), never the name, and the
  reservation above does not apply (`onclick` on a component is an ordinary prop).
  `onSideChange` reaches the component as `onSideChange`.

**Handler values.** In both domains, a handler-form attribute's value must be a
function at the time the event fires; `null`, `undefined`, and `false` mean "no
handler" (so `onClick={ open && fn }` needs no ternary). An expression that would
EXECUTE at setup (an assignment, `++`/`--`, a zero-argument call of a plain
reference) is a compile error - wrap it (`onClick={() => save()}`). Any other
non-function value is rejected with ONE rule text in every mode: at compile time
when it is statically evident, and by the identical runtime error from client
render, the serializer, and `h()` otherwise.

**Content ownership.** `innerHTML` and `textContent` OWN an element's content:
combining either with children is a rejected program
(`azeroth/content-property-children`), at compile time for markup and by the same
rule thrown from `h()` in every mode. A void element (`<input>`, `<br>`, ...) owns
NO content: children or a closing tag on one is a located parse error.

**Event attachment (observable model).** Handlers attach through ONE model in
every mode - client render, hydration, and `h()` alike. Types in the semantics
module's `DELEGATED_EVENTS` set share a single document-level dispatcher per type:
their handlers run when the event bubbles to the document, so a non-framework
listener between the element and the document that calls `stopPropagation()`
suppresses them - identically everywhere. All other types attach per element. The
dispatcher preserves per-handler `currentTarget`, `stopPropagation` ordering, and
`stopImmediatePropagation`.

**Uniqueness.** Within one element, every explicit attribute's full name must be
unique, and on components every EMITTED key must be unique; a violation is a
compile error. This is not style policing: repeated keys have no single meaning
across render modes (a template fires both duplicate listeners and keeps the FIRST
duplicate parsed attribute; an object literal keeps the LAST), so the language
refuses the program instead of picking a winner. Consequences:

- `children` is a key like any other: markup children and an explicit
  `children={...}` prop on the same component collide.
- `bind:p` claims BOTH `p` and its write-back callback key (below), so
  `bind:value={x} value={y}` collides.
- Exactly ONE authored handler may share a `bind:`'s callback key - that pairing
  is *composition*, defined below, not a collision.

**Two-way binding.** `bind:p={lvalue}` requires a writable reactive `lvalue` and
means, by definition: the target receives the current value of `lvalue` under key
`p`, and writes back through `wb(p)` - `change`/`onChange` when `p` is `checked`,
`input`/`onInput` otherwise (one rule for hosts and components; the on-chain key
for components, the DOM event for hosts). When an authored handler shares the
write-back key, both survive under ONE key and the write-back runs FIRST, so the
authored handler observes the state the user just produced.

**Merging.** Attributes and spreads merge in **source order, later wins** - the
semantics of a JavaScript object literal, in every mode and regardless of whether
a value is a literal or an expression. Two exceptions, both claims rather than
merges:

- `class:`/`style:` directives CLAIM their base key: the merged
  base + dynamic + toggles expression owns `class`/`style`, and no spread outranks
  it on that element.
- The uniqueness rule above removes explicit-vs-explicit competition entirely.

**Spreads.** A spread is an opaque runtime value; the language cannot and does not
inspect its keys statically. Its semantics are: **snapshot at instantiation** -
the spread's key set and values are read once when the element is created (getters
on the spread object are evaluated by the spread itself, per JavaScript). A spread
therefore does not forward *reactivity*; it forwards *values*. Passing live props
through requires passing them explicitly (or passing thunks as values). A spread
whose keys collide with explicit attributes resolves by the merge rule above; the
compile-time uniqueness rule does not apply to it.

**Mode equivalence.** For every program these rules accept, string rendering
followed by hydration is observably equivalent to client rendering - including
the event-attachment model above. `h()` is a JavaScript API, not markup: the
UNIQUENESS rules cannot apply to it (an object literal cannot express a duplicate
key) and spreads follow object-literal merge semantics by definition - but the
name-domain, handler-value, content-ownership, and attachment rules of this
section bind `h()` identically, so a reserved name, a non-function handler, or a
content-property/children combination is refused by `h()` with the same rule in
every mode.

**Reserved for the future.** Exact-case event syntax (`on:TypeName`, attaching
the event type verbatim - required for camelCase `CustomEvent` types on custom
elements) is reserved but NOT part of the language today; a conforming
implementation rejects it (`azeroth/reserved-event-name`) rather than guessing.
When adopted, `on:x` and any handler-form name whose lowercased tail is also `x`
denote the same event type and therefore collide under the uniqueness rule.

## 7. Keywords: all contextual, none reserved

`.azeroth` reserves NO identifiers beyond TypeScript's own. Every construct word is
contextual, active only in its exact position and shape:

| Word(s) | Active position | Gate |
| --- | --- | --- |
| `component` | module statement position | followed by `Identifier` and eventually `{` |
| `state` `derived` `deferred` `resource` `stream` `store` `selector` `form` | body statement position | followed by an identifier (the name) |
| `effect` | body statement position | followed by `(`, `with {`, or `{` |
| `batch` `untrack` `cleanup` `dispose` `mount` | body statement position | followed by `{` |
| `with` | after a declaration value / effect header, depth 0 | followed by `{` |

Everything else - including `ref`, `class:`/`style:`/`bind:` directives and event
names - is an ordinary identifier or a markup-layer attribute name.

**What earns keyword status** (the rubric, unchanged since the keyword set was
settled): a construct is a keyword only if it is a *reactive declaration that forces
the compiler to transform surrounding code* - rewriting reads, rewriting the
initializer + `with` clause, or binding lifecycle to the component's reactive root.
Imperative, non-reactive features are never keywords.

## 8. Explicit non-goals

- **No ASI for reactive declarations** - ever (§5). TypeScript statements inside
  opaque runs keep TypeScript's own ASI; the grammar takes no position there.
- **No expression grammar.** Interiors of values, holes, attributes, and parameters
  belong to TypeScript. The compiler will never fork expression syntax.
- **No syntax plugins.** The grammar is closed; there is no compiler plugin API and
  no user-extensible syntax.
- **No HTML compatibility promises** beyond §6: no doctype, no comments-in-markup
  (`<!-- -->`) - a hole with a TS comment serves that need. Entity decoding and
  newline-whitespace collapsing are in §6.4 and are the whole of it.
- **No angle-bracket casts, no comma-less generic arrows in body positions** (§3.3).
- **No new keywords without the §7 rubric** - and the current keyword set is
  settled; additions follow the syntax-stability policy, not ad-hoc need.

## 9. Pointers

- Reference implementation: `src/parser.ts` (module/body), `src/markup-parser.ts`
  (markup), `src/scanner.ts` (lexical + disambiguation), `src/keyword-spec.ts`
  (keyword -> runtime mapping and the rubric).
- Authoring guide with examples: this package's README, "Authoring idiom and
  reactivity".
