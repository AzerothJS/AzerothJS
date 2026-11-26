import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { azeroth } from '@azerothjs/compiler';
import { chromium } from 'playwright-core';
import { build } from 'vite';

test('compiled slots preserve iframe nodes and update a fragment range', async t =>
{
    const entry = fileURLToPath(new URL('./Parcel.azeroth', import.meta.url));
    const [bundle] = await build({
        configFile: false,
        logLevel: 'error',
        plugins: [azeroth({ ssr: false })],
        build: { write: false, lib: { entry, name: 'parcel', formats: ['iife'] } }
    });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent('<iframe></iframe><main></main>');
    await page.addScriptTag({ content: bundle.output[0].code });
    const observed = await page.evaluate(() =>
    {
        const frame = document.querySelector('iframe').contentDocument;
        const host = document.querySelector('main');
        const { ErrorBoundary, Parcel, createSignal, render } = window.parcel;
        const mount = value => render(() => Parcel({ value }), host);
        const cargo = frame.createElement('b');
        document.adoptNode(cargo);
        mount(cargo);
        const adopted = host.querySelector('b') === cargo;
        render(() => ErrorBoundary({ children: () => cargo, fallback: () => document.createElement('aside') }), host);
        const protectedNode = host.firstElementChild === cargo;

        const fragment = frame.createDocumentFragment();
        const label = frame.createTextNode('parcel');
        const box = frame.createElement('b');
        box.textContent = 'box';
        fragment.append(label, box);
        const [step, setStep] = createSignal(0);
        mount(() => step() === 0 ? fragment : 'sent');
        const [left, right] = host.querySelectorAll('i');
        const fragmentNodes = label.parentNode === left.parentNode && label.nextSibling === box;
        const before = host.textContent;
        setStep(1);
        const after = host.textContent;
        const keptSiblings = host.querySelector('i') === left && host.querySelector('section').lastChild === right;
        mount({ nodeType: 1, ownerDocument: document, nodeName: 'B' });
        return { adopted, protectedNode, fragmentNodes, before, after, keptSiblings, objectText: host.textContent };
    });
    assert.deepEqual(observed, {
        adopted: true, protectedNode: true, fragmentNodes: true, before: 'LparcelboxR',
        after: 'LsentR', keptSiblings: true, objectText: 'L[object Object]R'
    });
});
