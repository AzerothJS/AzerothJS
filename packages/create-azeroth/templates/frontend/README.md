<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="96" />

# {{name}}

**A compiled `.azeroth` app - no Virtual DOM, updates land on exact DOM nodes.**

[![Built with AzerothJS](https://img.shields.io/badge/built%20with-AzerothJS-5fb3e8)](https://github.com/AzerothJS/AzerothJS)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

</div>

---

## 🚀 Start here

```sh
npm install
npm run dev
```

Open the URL it prints. Click the state cell: `count` changes, and only the three
value text nodes update - that is the whole framework in one screen. Edit
`src/App.azeroth` and save; the change is live.

---

## 📜 Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Vite dev server with the azeroth compiler - edit and it's live. |
| `npm test` | Component tests over real DOM (happy-dom), through the same compiler that serves the app. |
| `npm run check` | The gate: `azeroth-tsc` typechecks every component, then eslint with the azeroth rules. |
| `npm run build` | Production bundle into `dist/`. |
| `npm run preview` | Serve the production bundle locally. |

CI runs the same three gates on every push - see `.github/workflows/ci.yml`.

---

## 🗂 Structure

| Path | Role |
| --- | --- |
| `src/main.azeroth` | Entry: `render(() => App(), ...)`. |
| `src/App.azeroth` | Your root component - `state`, markup, and plain TypeScript in one file. |
| `src/styles.css` | Design tokens and component styles, loaded from `index.html`. |
| `tests/` | `renderTest` component tests. |
| `public/` | Static assets served as-is (replace the favicon PNGs with your own). |

---

## ✍️ Writing a component

A `.azeroth` file is TypeScript with markup at the end of the function body. The
reactive keywords are the language, not an API:

```ts
export default component Counter()
{
    state count = 0;              // a signal
    derived doubled = count * 2;  // recomputes when count changes

    effect
    {
        document.title = `count: ${ count }`;
    }

    <button onClick={ () => count += 1 }>{ count } / { doubled }</button>
}
```

Hover any keyword in your editor (with the AzerothJS extension installed) for its
full documentation.

---

## 🚢 Deploy

`npm run build` emits a static `dist/` - deploy it to any static host: Netlify,
Vercel, Cloudflare Pages, GitHub Pages, or an S3 bucket. There is no server half.

---

## 📚 Next

- **Add pages** - rerun the scaffolder with `--router` for the framework's own
  client-side router (no extra dependency), or add it by hand from
  [the router docs](https://github.com/AzerothJS/AzerothJS).
- **Add a backend** - `npm create azeroth@latest` and pick `fullstack` for the
  canon tour: one shared typed contract across both halves, a schema-validated
  form, SSR and hydration.
- **[The AzerothJS repository](https://github.com/AzerothJS/AzerothJS)** for the
  full documentation.
