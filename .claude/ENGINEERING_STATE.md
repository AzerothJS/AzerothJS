# Engineering handoff

## Current framework handoff, 2026-11-21

**Unit 7 complete.** A-162, A-198, A-209, A-312 and A-317 share the resource/stream driver. The first effect run installs a memo for the logical key. Equal keys keep the active request. A warm refetch keeps the displayed data and Suspense subtree. A resource refetch follows superseding reads to the authoritative outcome, including when the key changes. Stream cancellation keeps the source subscription. Explicit demand in a seeded construction batch starts one read. The compiler now maps both source and comparator expressions back to their keyword options in editor diagnostics and hover. See the [decision, migration and evidence](decisions/resource-lifecycle.md). Find this revision with `git log -1 -- packages/azerothjs/src/reactivity/source-key.ts`.

The principal integrated resource and shared-cache settlement. Independent owners covered stream cancellation, regression controls, compiler/editor mapping and the packed app. Registered architecture and refutation roles challenged the design. The registered code reviewer approved the final source, tests and editor changes. Six reentrant router comparisons showed that explicit key resampling preserves the original single-slot handoff when caching is disabled.

On Windows, Node 24.22.3 and npm 11.18.0, `npm run verify` passed all 434 files, with 7,268 tests passing and two skipped. One earlier registry-backed CLI check timed out, then the 19-case release suite and full gate passed. `npm run smoke` passed all 15 workspaces, six executable targets and 625 shipped files. The packed SSR/hydrated consumer passed seven scenarios in each of Chromium, Firefox and WebKit, plus one compiled structural-key scenario per engine. Registered Playwright QA verified the draft, stream restart, authoritative waiters and construction seed in the final build with 37 successful HTTP responses and zero console messages.

**Open follow-up.** A-334 (tracker entry 50) concerns a nested factory during an outer effect's initial run. If its source disposes an ancestor before that outer effect registers with it, one request can start and then be aborted. Both the base and final revisions exhibit this distinct registration-order issue. A-288 and A-327 retain their separate seed questions.

**Next action.** Begin unit 8 at tracker entry 29. Reproduce A-163 by holding an async guard on the initial URL. Capture the served markup, initial fallback and mounted page through lazy resolution, then repeat with A-304's cold lazy page containing compiled control flow. Use those observations to design the related guard, lazy adoption and navigation-state rows in the canonical queue before editing the router.

**Previous work.** `18c3238` closed A-208, `72cd2ab` closed A-206 and A-207, and `54c148e` closed A-324 through A-326. See [fetcher tracking](decisions/fetcher-tracking.md) and [optimistic cache reads](decisions/optimistic-cache-reads.md). The original roadmap and tracker remain local to this checkout.

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
