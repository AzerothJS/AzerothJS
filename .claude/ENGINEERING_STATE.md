# Engineering handoff

## Current framework handoff, 2026-11-24

**Unit 16, A-158 and A-176 complete.** Division and regex literals retain their TypeScript meaning across compiler, editor and ESLint scans. A valid `batch` following a regex groups its writes with either brace spelling. The [lexical-context decision](decisions/compiler-lexical-context.md) records the cause, public tooling cursor, compatibility evidence and measured compile-time cost. Compiler/runtime contract 7 applies.

**Verification.** Full repository verification passed 8,262 tests in 466 files, with two skipped. Consumer smoke installed all 15 packages. The final packed ledger passed 27 Vite builds, 144 browser scenarios and six registered Playwright MCP workflows. All 6,400 frozen and recorded operations matched baseline. The 197,414 targeted historical cases produced 45,478 newly passing cases and zero newly rejected ones. Earlier cross-products were sampled. The four independent editor and dependency-list gaps are A-342 through A-345, tracker entries 58–61.

**Next action.** Continue unit 16 with A-169. Reproduce `state x, y = 2;` and an uninitialized declaration followed by a statement without its semicolon. Check where the emitter discards the tail, then compare diagnostics and projection for ordinary and operator-word names. Find the A-158/A-176 commit with `git log -1 -- .claude/decisions/compiler-lexical-context.md`.

**Previous work.** `7b4109b` fixed [bare table rows and clone placement](decisions/table-row-rendering.md). `9305d00` fixed [HTML and foreign text handling](decisions/namespace-text.md). `9e15126` fixed [row shorthand and prop default scope](decisions/prop-defaults-and-row-shorthand.md). `f697a37` fixed [lexical names in reactive expressions](decisions/reactive-name-resolution.md). `5db831b` fixed [locale prerendering and serving](decisions/locale-prerender.md). `f866b51` fixed [static text adoption and hydration fallback reporting](decisions/static-text-hydration.md). `dcfee32` fixed [conditional branch selection](decisions/branch-selection.md). `3d0846a` fixed [branch value lifetime](decisions/branch-value-lifetime.md). `86229c0` fixed [Show condition ownership](decisions/show-condition-ownership.md). `ca464f8` fixed [streamed seed ownership and Suspense watch lists](decisions/stream-seed-ownership.md). `b87d15f` fixed [component and error boundary construction](decisions/component-construction.md). `04fc843` fixed [lexical bindings in render callbacks](decisions/compiler-arrow-bindings.md). `b945b60` completed [rendered route ownership](decisions/rendered-route-ownership.md) after unit 8 (`758a3a4`). The original roadmap and tracker remain local to this checkout.

## Bootstrap history

**ENG-BOOTSTRAP, 2026-11-21.** Shared configuration and native transport verification were committed on `main`. Two maintainer actions were recorded for full portability and normal Claude use.

## Decision and delivered files

Keep the existing roadmap, bug tracker and design records at their original paths. Both providers use [one engineering protocol](ENGINEERING_PROTOCOL.md), [one architecture index](ARCHITECTURE_INDEX.md) and [ten role specifications](agent-specs/). The security reviewer inspects defensive controls and uses inert fixtures. Product statuses and framework behavior were outside this bootstrap.

| Local commit | Contents |
| --- | --- |
| `714fbe8` | Shared protocol, handoff, index, ten role specs and selective Git ignore rules. |
| `70ced1e` | Root `AGENTS.md` and `CLAUDE.md`, ten Claude Markdown adapters and ten Codex TOML adapters. |
| `5d43289` | Project MCP settings for both providers, Claude tool restrictions and the [reproducible browser check](PLAYWRIGHT_MCP.md). |

This handoff's own revision is available with `git log -1 -- .claude/ENGINEERING_STATE.md`. Run `git diff --name-status a9eb35c..5d43289` for the exact set of added and changed paths.

## Verification and limits

- **Baseline.** Clean index and working tree at `a9eb35c`. The 2.1.1 monorepo had 15 workspaces, 44 tracked Markdown files, and 428 specs under the Vitest discovery pattern plus five scaffold specs. The [index](ARCHITECTURE_INDEX.md) maps public contracts, source/test boundaries, and the 70 pre-existing Claude Markdown files. Existing browser logs were local artifacts. There was no tracked Playwright Test runner or configuration.
- **Native checks.** On Windows with Node 25.9.0 and npm 11.12.1, `npm run typecheck` passed before and after configuration. `npm test -- packages/schema/tests/standard-schema.spec.ts` passed 4/4 both times. The full framework build, lint, Vitest suite and package smoke were not executed for these documentation and agent configuration changes.
- **Role discovery.** Claude Code 2.1.322 SDK initialization returned all ten project roles after the final YAML change. Codex CLI 0.153.4 exposed all ten names and descriptions in its native spawn-tool schema captured locally. This checked registration without model-driven runs of the ten specialists. Structural checks parsed both formats, resolved references, compared the two adapters for each role, and verified read/write scopes and MCP configuration parity.
- **Browser.** Both native clients navigated, inspected, clicked and verified a new heading through the pinned Playwright MCP. A repeat with the documented two-page fixture returned four HTTP 200s across the two sessions, with zero console messages. Only isolated Chrome on Windows was exercised. The [evidence and commands](PLAYWRIGHT_MCP.md) distinguish direct client transport from a normal authenticated chat.
- **Git and review.** Independent review covered the actual protocol, index, roles, adapters, permissions, browser runbook and Git isolation. The committed engineering tree contains 40 paths including `.gitignore`. The two original canonical files matched their pre-edit SHA-256 values and were excluded from all bootstrap commits. Git visibility checks leave personal permissions, legacy worktrees and browser output ignored.

## Resume

1. **In this checkout:** Read the current framework handoff above, the protocol and canonical records from the repository root. Use the named next action and the project’s registered roles.
2. **For Claude's normal workflow:** Run `claude auth login`, start `claude` in this checkout and approve the project server named `playwright`. Verify it in `/mcp` and repeat the documented fixture. The native explicit-config path passed. Default project approval and the expired OAuth login still require the maintainer.
3. **For another clone:** The original `.claude/ROADMAP.md` and `.claude/framework-bugs.md` are untracked here. A Git archive of the bootstrap excludes both. Restore them from the maintainer, together with the roadmap skill and any referenced design dossiers or scoped workflows needed for the task. To make these available through Git, the maintainer must authorize a separate reviewed import of pre-existing knowledge. Keep the original names and review exact files before staging. Personal settings, browser output and nested worktrees stay private.
