// @vitest-environment happy-dom
//
// bootClient's whole contract, against REAL render/hydrate/renderToString - no
// mocks: an empty shell renders, server markup is ADOPTED in place (the same
// nodes, not rebuilt), the embedded loader handoff reaches the app, and a missing
// root is a loud error.
import { afterEach, describe, expect, it } from 'vitest';

import type { LoaderHandoff } from 'azerothjs';
import { h, renderToString, LOADER_HANDOFF_ID, loaderHandoffScript } from 'azerothjs';
import { bootClient } from '@azerothjs/kit/client';

const App = (): HTMLElement => h('main', {}, h('h1', {}, 'hello'));

afterEach(() =>
{
    document.body.innerHTML = '';
    document.getElementById(LOADER_HANDOFF_ID)?.remove();
});

describe('bootClient', () =>
{
    it('renders into an empty shell (the dev server / a client page)', () =>
    {
        document.body.innerHTML = '<div id="root"></div>';
        bootClient(() => App());
        expect(document.querySelector('#root h1')?.textContent).toBe('hello');
    });

    it('ADOPTS server markup in place - the same node survives, not a rebuild', () =>
    {
        document.body.innerHTML = `<div id="root">${ renderToString(() => App()) }</div>`;
        const serverNode = document.querySelector('#root h1');
        expect(serverNode).not.toBeNull();

        bootClient(() => App());
        expect(document.querySelector('#root h1')).toBe(serverNode);
    });

    it('hands the embedded loader handoff to the app', () =>
    {
        document.head.insertAdjacentHTML('beforeend',
            loaderHandoffScript({ version: 2, path: '/x', data: [{ n: 1 }] }));
        document.body.innerHTML = '<div id="root"></div>';

        let received: LoaderHandoff | undefined;
        bootClient((props) =>
        {
            received = props.handoff;
            return App();
        });
        expect(received).toEqual({ version: 2, path: '/x', data: [{ n: 1 }] });
    });

    it('a missing #root is a loud error, not a silent no-op', () =>
    {
        expect(() => bootClient(() => App())).toThrow(/#root/);
    });
});
