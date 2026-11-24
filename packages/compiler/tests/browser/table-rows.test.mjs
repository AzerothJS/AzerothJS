import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { azeroth } from '@azerothjs/compiler';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const entry = fileURLToPath(new URL('./Inventory.azeroth', import.meta.url));

for (const ssr of [true, false])
{
    test(`compiled tables keep their live cell and section in Chromium (ssr=${ ssr })`, async t =>
    {
        const [bundle] = await build({
            configFile: false,
            logLevel: 'error',
            plugins: [azeroth({ ssr })],
            build: { write: false, lib: { entry, name: 'inventory', formats: ['iife'] } }
        });
        const browser = await chromium.launch();
        t.after(() => browser.close());
        for (const component of ['Stock', 'Summary', 'Warehouses', 'NativeContent', 'LeadingSection', 'StoredTable'])
        {
            await t.test(component, async scenario =>
            {
                const page = await browser.newPage();
                scenario.after(() => page.close());
                const errors = [];
                page.on('pageerror', error => errors.push(error.message));
                await page.addScriptTag({ content: bundle.output[0].code });
                await page.evaluate(name => window.inventory.render(window.inventory[name], document.body), component);
                if (component === 'Stock')
                {
                    const cell = await page.locator('table > tbody > tr > td').first().elementHandle();
                    assert.equal(await cell.textContent(), '1');
                    await page.getByRole('button', { name: 'Receive' }).click();
                    assert.equal(await cell.textContent(), '2');
                    assert.equal(await cell.evaluate(node => node.isConnected), true);
                }
                else if (component === 'StoredTable')
                {
                    const children = await page.locator('template').evaluate(template =>
                    {
                        const table = template.content.querySelector('table');
                        return [...table.childNodes].map(node =>
                            node.nodeType === Node.TEXT_NODE ? node.data : node.localName);
                    });
                    assert.deepEqual(children, ['tbody', '', '3', 'aside']);
                    assert.equal(await page.locator('template').evaluate(template =>
                        template.content.querySelector('aside > input').defaultValue), 'stock');
                }
                else if (component === 'NativeContent')
                {
                    assert.deepEqual(await page.locator('table').evaluate(table =>
                        [...table.children].map(child => child.localName)), ['colgroup', 'tbody']);
                    assert.equal(await page.locator('tbody > script').textContent(), '0');
                    assert.equal(await page.locator('tbody > template').evaluate(node => node.content.textContent), 'Card');
                    assert.equal(await page.locator('tbody > tr').count(), 2);
                }
                else
                {
                    if (component === 'LeadingSection')
                    {
                        assert.equal(await page.locator('#card').evaluate(node => node.content.textContent), 'Card');
                        assert.equal(await page.locator('table > tbody > tr').count(), 1);
                        await page.getByRole('textbox').fill('changed');
                        await page.getByRole('checkbox').uncheck();
                        await page.getByRole('button', { name: 'Reset' }).click();
                        assert.equal(await page.getByRole('textbox').inputValue(), 'stock');
                        assert.equal(await page.getByRole('checkbox').isChecked(), true);
                    }
                    await page.getByRole('button', { name: 'Toggle total' }).click();
                    assert.equal(await page.locator('table > tfoot').textContent(), 'Total');
                    await page.getByRole('button', { name: 'Toggle total' }).click();
                    assert.equal(await page.locator('tfoot').count(), 0);
                }
                assert.deepEqual(errors, []);
            });
        }
    });
}
