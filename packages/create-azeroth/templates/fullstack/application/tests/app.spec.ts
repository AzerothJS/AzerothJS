// Component tests run against real DOM (happy-dom) through the compiler - the same
// pipeline that serves the app. renderTest mounts, cleanup unmounts between tests.
// App takes a `url` so tests (like the kit's SSR renderer) pin the route.
import { describe, it, expect, afterEach } from 'vitest';
import { renderTest, cleanup, fire } from '@azerothjs/testing';

import App from '../src/App.azeroth';

afterEach(cleanup);

describe('App', () =>
{
    it('renders the home route and counts fine-grained - only the text node updates', () =>
    {
        const { container } = renderTest(() => App({ url: '/' }));
        const button = container.querySelector<HTMLButtonElement>('button.cell');
        expect(button?.textContent).toContain('count = 0');
        if (button)
        {
            fire(button, 'click');
        }
        expect(button?.textContent).toContain('count = 1');
        expect(container.textContent).toContain('parity = odd');
    });

    it('the guest book route renders the schema-validated form', () =>
    {
        const { container } = renderTest(() => App({ url: '/guestbook' }));
        expect(container.querySelector('form')).not.toBeNull();
        expect(container.querySelectorAll('input').length).toBe(2);
    });
});
