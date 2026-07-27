## Tailwind CSS

This app was scaffolded with `--tailwind`: Tailwind v4 through `@tailwindcss/vite`
(no PostCSS config) in the application half. `application/src/styles.css` imports
Tailwind and maps the starter's design tokens to utilities via `@theme inline` -
`bg-panel`, `text-ice`, `border-line`, `font-mono` - so components style
themselves inline and stay on the same palette in light and dark. The build and
prerender pipeline is unchanged.
