// Component tests run against real DOM (happy-dom) through the compiler - the same
// pipeline that serves the app. renderTest mounts, cleanup unmounts between tests.
import { describe, it, expect, afterEach } from 'vitest';
import { renderTest, cleanup, fire } from '@azerothjs/testing';

import App from '../src/App.azeroth';

afterEach(cleanup);

describe('App', () =>
{
    it('renders and counts fine-grained - only the text node updates', () =>
    {
        const { container } = renderTest(() => App());
        const button = container.querySelector('button');
        expect(button?.textContent).toContain('count is 0');
        if (button)
        {
            fire(button, 'click');
        }
        expect(button?.textContent).toContain('count is 1');
    });
});
