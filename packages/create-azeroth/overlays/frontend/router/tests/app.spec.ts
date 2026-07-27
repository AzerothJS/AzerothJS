// Component tests run against real DOM (happy-dom) through the compiler - the same
// pipeline that serves the app. App takes a `url` so tests pin the route.
import { describe, it, expect, afterEach } from 'vitest';
import { renderTest, cleanup, fire } from '@azerothjs/testing';

import App from '../src/App.azeroth';

afterEach(cleanup);

describe('App', () =>
{
    it('renders the home route and counts fine-grained - only the value text nodes update', () =>
    {
        const { container } = renderTest(() => App({ url: '/' }));
        const button = container.querySelector('button.cell');
        expect(button?.textContent).toContain('count = 0');
        if (button)
        {
            fire(button, 'click');
        }
        expect(button?.textContent).toContain('count = 1');
        expect(container.textContent).toContain('parity = odd');
        expect(container.textContent).toContain('doubled = 2');
    });

    it('the about route renders through the same table', () =>
    {
        const { container } = renderTest(() => App({ url: '/about' }));
        expect(container.querySelector('h1')?.textContent).toBe('About');
        expect(container.textContent).toContain('src/routes.ts');
    });

    it('the nav links both pages', () =>
    {
        const { container } = renderTest(() => App({ url: '/' }));
        const links = [...container.querySelectorAll('nav a')].map((a) => a.getAttribute('href'));
        expect(links).toEqual(['/', '/about']);
    });
});
