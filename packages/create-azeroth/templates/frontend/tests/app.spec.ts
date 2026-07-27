// Component tests run against real DOM (happy-dom) through the compiler - the same
// pipeline that serves the app. renderTest mounts, cleanup unmounts between tests.
import { describe, it, expect, afterEach } from 'vitest';
import { renderTest, cleanup, fire } from '@azerothjs/testing';

import App from '../src/App.azeroth';

afterEach(cleanup);

describe('App', () =>
{
    it('renders and counts fine-grained - only the value text nodes update', () =>
    {
        const { container } = renderTest(() => App());
        const button = container.querySelector('button');
        expect(button?.textContent).toContain('count = 0');
        if (button)
        {
            fire(button, 'click');
        }
        expect(button?.textContent).toContain('count = 1');
        // The derived cells recomputed from the same click.
        expect(container.textContent).toContain('parity = odd');
        expect(container.textContent).toContain('doubled = 2');
    });
});
