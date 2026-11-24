# Division, regular expressions and framework statements

## A-158 and A-176

At `7b4109b`, division after a non-null assertion can consume the closing markup tag as part of a supposed regex. At module scope the same scan can hide the following component. A regex after a typed declaration can instead be split into punctuation and identifiers. In a real handler, reading `class Foo` from inside the regex changed the scope assigned to the following block. Its authored `batch` never reached lowering. A same-line brace then failed the build. A next-line brace produced executable JavaScript that either threw or notified subscribers twice when a helper with the same name was already imported.

## Decision

Share the lexical decision for slash and angle brackets across the parser, balanced regions, markup search and keyword discovery. Keep traversal context local to its source. Retain the existing markup grammar, namespace and located error policy at each boundary. TypeScript identifier characters and whitespace in code must not alter the HTML rules. Use TypeScript's grammar where a typed declaration or a generic close makes the goal ambiguous. Any syntax-tree evidence must identify the actual token. Recovery in a file containing framework syntax cannot establish a token's meaning by absence alone.

Keep framework keyword admission at the documented statement boundaries. A genuine keyword form at such a boundary must be lowered or receive a located diagnostic shared by compilation and editor tooling. A method, property, ordinary call, explicitly terminated name, unbraced control body or ASI-only start keeps its existing interpretation. A-159 covers expansion of those boundaries. Preserve the existing public compiler interfaces, grammar for markup, runtime helper signatures, ownership and contract 7. The compiler and projection are affected. No runtime package change or new external dependency is needed.

The previous keyword walker corrected a private copy of the slash decision, leaving markup and module scanning exposed. Repeating that repair in each caller would preserve the disagreement. Treating all slashes after a line break as regex changes valid division across lines. A global search for keyword names would flag ordinary methods and strings. The independent refuter supplied controls for each case. Avoid per-token full-source parsing or unbounded caches in builds and editor sessions.

## Acceptance

Exercise postfix assertion and update, member and Unicode identifiers, spread, statement heads, object and block closing braces, type arguments, regex followed immediately by division and regex statements after typed declarations. Compare emitted code, editor projection and diagnostics across body, module, handler, markup hole, attribute and template substitution. Run the established keyword generator tests and compare available application inputs. In the packed app check both brace spellings and the observation sequence from two supposedly batched writes. Run the final compiler in Vite, SSR, real browser controls and registered Playwright MCP.

## Baseline and controls

The four pre-existing scanner, parser and keyword suites passed 1,175 tests at `7b4109b`. The packed parcel ledger then failed 15 of its 27 Vite builds. Registered Playwright MCP confirmed both runtime outcomes on a production hydration. With a same-named helper, two clicks exposed `0/0, 1/0, 1/1, 2/1, 2/2` to the observer with an empty console. Without the helper the first click raised `ReferenceError: batch is not defined`. The parenthesized control recorded only `0/0, 1/1, 2/2` and its balance advanced from 4 to 5. All three adopted the original input and retained the text entered before startup.

The 80 permanent compiler regressions and controls ran against an archive of that commit. They produced 51 failures and 29 passes. All 80 pass with the corrected compiler. Four companion tests exercise the language service and ESLint through their real entry points.

Three isolated changes tested the assertions themselves. Removing postfix recognition broke the non-null division in both emit modes while the parenthesized operand still rendered 6. Disabling the check for a real enclosing statement block left a contextual-type fixture's `batch` bare in the projection and recorded only the initial value on click. Removing runtime grouping alone preserved syntactically correct output but changed the observed sequence from `[0, 2]` to `[0, 1, 2]`. The ordinary object-method control retained its two separate notifications.

## Implementation and review

The parser, markup readers, analyzer, emitter, diagnostics, projection and keyword lowering share a forward code walker. It tracks operands and statement heads and asks TypeScript for an actual regex or operator node at ambiguous positions. Consumed markup becomes one padded operand for this question, preserving original offsets and line terminators even for HTML void elements. A statement-list check can recover an admitted keyword after the structural scan assigns the enclosing brace the wrong role. Both tree walks use an explicit stack.

The original two-argument `findMarkupStart` starts a fresh statement search. Its companion `createMarkupSearch` lets the caller supply a source range and retain lexical context while skipping each parsed markup tree. The language server and ESLint processor use the same search as the compiler. This matters for code such as `const half = <Measure/> / 2` followed by a second tag. Without the preceding operand the next search skipped the second tag, suppressing its editor diagnostics and allowing ESLint to rename it in an autofix.

Independent code review found cases outside the recovered generated corpus. They included a statement block before markup, a private-field brand check before a regex, restricted statements followed by a regex, Unicode line separators, an object literal at the start of a hole, and a declaration list containing both HTML markup and a generic cast. Regression tests now exercise those boundaries. In a separate check, the standalone walk over an 8,000-term expression completed and preserved an ordinary method named `effect`.

Two historical G7 inputs supplied a further distinction. After a label or generic class declaration, `! /pattern/` starts a new expression. After an object or class expression, a postfix `!` can precede division. The compiler asks TypeScript for the prefix, postfix or non-null operator at that offset. The reviewer exercised 37 examples. Disabling only this check reproduced 19 failures, including lost render output after labels and invalid regex diagnostics in the update-operator variants.

## Editor and dependency-list findings

The editor projection now uses the parsed spread attribute's end. A separate partial scanner had truncated its generated TypeScript at a brace inside a regex or comment. The regression checks both host and component attributes and maps a position beyond the brace back to the source.

Two other editor features read their own text slices. A regex in a reactive option can suppress the following option's completion, and an escaped closing brace in a component regex prop can hide the following prop's hover. The packed language service reproduced each with valid projected TypeScript. A-342 and A-343 record those provider defects. A-344 records a separate dependency-list bug. The comma between two type arguments creates a third watch getter and the first getter throws at runtime. Parenthesizing the entire generic call preserves the two intended dependencies. A-345 tracks partial-tag suggestions after `{} <props.` inside a comparison. Adding a space after the operator restores the property suggestions.

## Packed application and performance

The final packed compiler built all 27 Vite targets. Buffered and streamed HTML agreed on all nine pages. All 144 fixture checks passed across development Chromium and production Chromium, Firefox and WebKit. Registered Playwright MCP drove six workflows on Windows Headless Chrome 158, covering both brace spellings, hydration with and without another helper import, non-null division in a hole or attribute, and a generic cast. Both updates preserved the draft on every route and each of the five hydrated pages kept its server input. All 138 requests returned HTTP 200. The console contained two Vite connection debug messages and no application errors.

Sequential measurements on the same machine compared the two packed compilers at 1,024 rows. Ordinary division holes took 0.77 ms on baseline and 4.51 ms on the correction. Newline divisions took 0.82 ms and 4.46 ms respectively, down from 32 ms in the first candidate. The final compiler invoked the TypeScript parser zero times in both ordinary cases. The baseline rejects the mixed generic and non-null case. The correction took 19.21 ms. A separate instrumented run counted 2,048 short syntax-tree parses totaling 112,640 input characters. These are local compiler timings. Generated runtime code has no dependency on the new scanner.

## Historical compatibility

The test engineer recovered the original A-130 generator and refuter inputs. The full 250,193-input classifier and the two lead matrices (3,109 and 3,173 cases) matched the packed baseline. The frozen 532-file corpus covered 2,128 emits and 532 calls each to projection and diagnostics. In a separate recorded replay, two malformed adjacent-root emits differed in the first reviewed package. The existing codegen regression requires both operands to be present in the generated syntax error.

The focused historical pipeline and mutation run used all 106,960 LF inputs from the two later typed generators, 36,040 CRLF inputs and 54,414 mutations on the frozen source corpus. The reviewed package produced 45,478 newly passing cases. Ten more changed while continuing to pass. The round-one regex family reported 20 lost downstream captures across different frames for the same input, `a++` followed by `/=>/.test(s)` on the next line. Both Node and esbuild rejected that source. The TypeScript syntax-only oracle had admitted it.

The accepted compiler also matched every one of the 3,208 recorded calls, including the two adjacent-root emits. The G7 brace, bang and slash sweep enumerated 260,000 placements, selected 5,928 and ran the 2,340 admitted by the original grammar oracle. The corrected result had 800 gains and preserved every earlier passing output. The seven original LF lexical families ran 8,310,322 comparable scans. They identified 6,792 gains and the 20 invalid-input losses above. Earlier generator and writer pools were sampled. All 21,153 additional typed and mutation cases and the separate first-round pipeline sample of 2,974 from 14,825,141 placements produced zero newly rejected inputs.

On the real language service, 155 of the 190 named historical documents had no errors, up from 81 at baseline. The 35 remaining documents reported only TS2362 for arithmetic on deliberately unusual operand types. The unknown-`batch` diagnostic fell from 48 documents to zero. After division of a component result, the installed service once again supplied the later native tag's spacing diagnostic, linked rename ranges, closing tag and HTML completions. Component prop hover and definition also resolved to the right source.

## Repository gates

On Windows with Node 24.22.3 and npm 11.18.0, `npm run verify` passed the build, lint, typecheck, publish checks and 8,262 tests in 466 files, with two skipped. A subsequent `npm run smoke` packed and installed all 15 workspaces, loaded the runtime and compiler exports and checked all six binary targets. The independent reviewer approved the final 19 source and test paths. The packed compiler used for final browser and historical evidence had SHA-256 `ac2176207b4a52e952065db319558034a5cdda47eb27e58201954a7c7b5876ee`.
