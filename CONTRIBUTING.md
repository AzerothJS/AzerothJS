# Contributing to QuantumJS

Thank you for your interest in contributing to QuantumJS! Every contribution matters — whether it's fixing a typo, reporting a bug, or implementing a new feature.

## Getting Started

### Prerequisites

- **Node.js** 20+
- **npm** 10+
- **TypeScript** 6+

### Setup

```bash
git clone https://github.com/IntelligentQuantum-Dev/QuantumJS.git
cd QuantumJS
npm install
```

### Scripts

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript |
| `npm run dev` | Compile in watch mode |
| `npm test` | Run tests with Vitest |

## Project Structure

```
src/
├── reactivity/     # Signals, effects, memos, batch, untrack, etc.
├── renderer/       # h(), render(), Show, For, Switch, Portal, etc.
├── component/      # defineComponent, QuantumComponent, lifecycle
├── core/           # Shared utilities (future)
├── router/         # Official router (future)
├── store/          # Global store (future)
├── compiler/       # .quantum compiler (future)
└── index.ts        # Public API entry point

test/               # Mirrors src/ structure
demo/               # Interactive demo app
```

## Development Guidelines

### Code Style

- **Brace style:** Allman (opening brace on its own line)
- **Indentation:** 4 spaces
- **Quotes:** Single quotes
- **Semicolons:** Always
- **Line endings:** LF (Unix)

ESLint is configured to enforce these rules. Run your editor's ESLint integration or check manually:

```bash
npx eslint src/
```

### Naming Conventions

- **Functions:** `camelCase` — `createSignal`, `createEffect`
- **Types/Interfaces:** `PascalCase` — `Subscriber`, `SignalOptions`
- **Constants:** `UPPER_SNAKE_CASE` — `DOM_PROPERTIES`
- **Files:** `kebab-case` — `create-root.ts`, `on-cleanup.ts`
- **Internal exports:** Prefixed with `@internal` in JSDoc

### Writing Code

- Write **complete JSDoc** for every public function, type, and interface
- Include `@param`, `@returns`, and at least one `@example`
- Add educational comments explaining **WHY**, not just **WHAT**
- Keep functions small and focused
- No external runtime dependencies

### Tests

Every feature must have tests. We use [Vitest](https://vitest.dev/) with `happy-dom`.

```bash
# Run all tests
npm test

# Run a specific test file
npx vitest run test/reactivity/signal.test.ts

# Run in watch mode
npx vitest
```

**Test file location:** Mirror the source structure under `test/`.

```
src/reactivity/signal.ts    →  test/reactivity/signal.test.ts
src/renderer/show.ts        →  test/renderer/show.test.ts
src/component/types.ts      →  test/component/types.test.ts
```

**Test structure:**

```ts
import { describe, it, expect } from 'vitest';
import { createSignal } from '../../src/index.ts';

describe('createSignal', () =>
{
    it('should return initial value', () =>
    {
        const [count] = createSignal(0);
        expect(count()).toBe(0);
    });
});
```

### Commits

Use clear, descriptive commit messages:

```
feat: add createSelector for efficient list selection
fix: prevent memory leak in effect cleanup
test: add tests for createDeferred debounce behavior
docs: update API reference for onCleanup
refactor: simplify batch queue flushing logic
```

## Reporting Bugs

Open an issue with:

1. **Description** — What happened vs what you expected
2. **Reproduction** — Minimal code that demonstrates the bug
3. **Environment** — Node version, OS, browser (if applicable)

## Requesting Features

Open an issue with:

1. **Use case** — What problem does this solve?
2. **Proposed API** — How should it look?
3. **Alternatives** — What other approaches did you consider?

## Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Write your code with tests
4. Ensure all tests pass: `npm test`
5. Submit a pull request with a clear description

### PR Checklist

- [ ] Code follows the project's style guidelines
- [ ] JSDoc is added for all public APIs
- [ ] Tests are added and passing
- [ ] No breaking changes (or clearly documented if intentional)
- [ ] Commit messages are clear and descriptive

## Architecture Overview

QuantumJS uses **fine-grained reactivity** with zero Virtual DOM:

1. **Signals** hold reactive state
2. **Effects** subscribe to signals and re-run on changes
3. **The renderer** (`h()`) creates real DOM elements and wires up effects for reactive attributes and children
4. **Components** (`defineComponent` / `QuantumComponent`) provide structure, props, and lifecycle

There is no diffing, no reconciliation, no virtual nodes. When a signal changes, only the specific DOM nodes that depend on it are updated directly.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
