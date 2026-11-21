# Engineering handoff

## Current framework handoff, 2026-11-21

**Unit 8 complete.** A-163, A-304, A-178, A-180, A-177 and A-179 close tracker entry 29. An undecided client boot exposes `{ kind: 'pending' }`. A held later guard retains the previous presentation. A query change starts a new guard decision and its loaders wait for admission. The accepted boot URL owns its server nodes and loader seeds. Cold control flow adopts those nodes, including the visible Suspense branch, without losing a preboot draft. See [decision, migration and evidence](decisions/router-boot.md). Find this revision with `git log -1 -- .claude/decisions/router-boot.md`.

The principal integrated router verdicts, loader handoff and streamed branch ownership. Separate owners handled route/renderer adoption, regressions and packed browser QA. Independent review led to corrections for rejected partial roots, shared-cache precedence, parser-inserted table bodies and queued resource initialization. The registered code reviewer approved the integrated implementation.

On Windows with Node 24.22.3 and npm 11.18.0, `npm run verify` passed all 436 files (7,358 passed, two skipped). Two earlier registry timeouts passed on the isolated release suite and full rerun. `npm run smoke` passed all 15 packages, six executable targets and 627 shipped files. The packed app passed 99 cases across Chromium, Firefox and WebKit. Registered Playwright QA exercised five workflows including a real pending resource in a cold compiled page. All 22 final responses were HTTP 200.

**Next action.** Start the A-316 audit from tracker entry 47, alongside A-315 and A-311. Recheck reachability in shipped templates, public examples and a write-recording fixture. Compare segment-scoped composables that freeze the leaving page’s match with the scheduler ownership option against A-128’s existing guarantees. Use the audit to settle priority and design before changing either subsystem.

**Open follow-ups.** A-288 covers construction-order identity of stream seeds. A-334 (tracker entry 50) covers ancestor disposal during an outer effect’s first run. Older stream runtimes do not record whether a numbered boundary has already been swapped. The new client uses the prior loading-based inference on that markup.

**Previous work.** `8196b48` completed unit 7, `18c3238` closed A-208, `72cd2ab` closed A-206 and A-207, and `54c148e` closed A-324 through A-326. The original roadmap and tracker remain local to this checkout.

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
