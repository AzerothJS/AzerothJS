# {{name}}

> The MINIMAL starter for this half. The `fullstack` template is the canon tour -
> routing, the shared typed contract, the schema-validated form, and an SSR'd +
> hydrated route - scaffold it with `npm create azeroth@latest` and pick fullstack.

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
| `public/` | Static assets served as-is (replace the favicon PNGs with your own). |

## Options

This shape scaffolds with `--router` (pages + nav on the framework's own
client-side router, no extra dependency) and/or `--tailwind` (Tailwind v4 via
`@tailwindcss/vite`). An applied option documents itself in a section below.

## Deploy

`npm run build` emits a static `dist/` - deploy it to any static host. Hover any
keyword in your editor (with the AzerothJS extension) for its full documentation.
