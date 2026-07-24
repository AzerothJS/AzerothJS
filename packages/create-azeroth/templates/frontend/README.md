# {{name}}

An [AzerothJS](https://github.com/AzerothJS/AzerothJS) app: `.azeroth` single-file
components, compiled - no Virtual DOM, updates hit exact DOM nodes.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | vite dev server with the azeroth compiler - edit `src/App.azeroth`, it's live |
| `npm test` | component tests over real DOM (happy-dom), through the same compiler |
| `npm run check` | `azeroth-tsc` typecheck of every component + eslint |
| `npm run build` | production bundle into `dist/` |
| `npm run preview` | serve the production bundle locally |

## Structure

| Path | Role |
| --- | --- |
| `src/main.azeroth` | Entry: `render(() => App(), ...)`. |
| `src/App.azeroth` | Your root component - `state`, markup, and plain TypeScript in one file. |
| `tests/` | `renderTest` component tests. |
| `public/` | Static assets served as-is (replace `favicon.svg` with your own). |

## Deploy

`npm run build` emits a static `dist/` - deploy it to any static host. Hover any
keyword in your editor (with the AzerothJS extension) for its full documentation.
