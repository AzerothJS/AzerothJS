// Lets TypeScript resolve imports of `.azeroth` files. The Vite
// plugin compiles the markup → h(); each module default-exports a
// component (function or class instance factory).
declare module '*.azeroth'
{
    const component: (props?: Record<string, unknown>) => HTMLElement;
    export default component;
}
