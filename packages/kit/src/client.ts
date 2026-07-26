/**
 * MODULE: kit/client - the browser boot (client-safe entry)
 *
 * `bootClient(App)` is the whole client entry: a page that arrived WITH markup
 * (an SSR'd or prerendered route) is ADOPTED via hydrate(); an empty shell (the
 * dev server, a `render: 'client'` route) renders normally. The loader handoff
 * embedded by the server is read back so hydration never refetches what the
 * server just loaded.
 */

import type { LoaderHandoff, MountNode } from 'azerothjs';
import { hydrate, readLoaderHandoff, render } from 'azerothjs';

/** The app-component signature (the same seam kit/ssr drives server-side). */
export type ClientApp = (props: { handoff?: LoaderHandoff }) => MountNode;

/**
 * Mounts the application: hydrate over server markup, render into an empty shell.
 * The root defaults to `#root` (the shell contract shared with kit/ssr).
 */
export function bootClient(app: ClientApp, root?: HTMLElement): void
{
    const target = root ?? document.getElementById('root');
    if (target === null)
    {
        throw new Error('kit: no #root element to mount into - the index.html shell must contain <div id="root"></div>.');
    }
    const handoff = readLoaderHandoff();
    const build = (): MountNode => app(handoff !== undefined ? { handoff } : {});
    if (target.childNodes.length > 0)
    {
        hydrate(build, target);
    }
    else
    {
        render(build, target);
    }
}
