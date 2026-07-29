---

## 🎨 Tailwind CSS (applied)

This app was scaffolded with `--tailwind`: Tailwind v4 through `@tailwindcss/vite`
in the application half, with no PostCSS config to maintain.

`application/src/styles.css` imports Tailwind and maps the starter's design tokens
to utilities through `@theme inline`, so the palette is one source of truth:

| Utility | Token |
| --- | --- |
| `bg-panel` | the raised surface colour |
| `text-ice` | the accent |
| `border-line` | the hairline |
| `font-mono` | the code face |

Components style themselves inline and stay on the same palette in light and dark.
The build, SSR and prerender pipeline is unchanged.
