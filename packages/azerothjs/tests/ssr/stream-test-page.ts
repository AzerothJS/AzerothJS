import { render } from 'azerothjs';
import { azsRuntime } from '../../src/renderer/stream-swap.ts';

const host = globalThis as typeof globalThis & {
    __AZS?: (id: number) => void;
    __AZS_S?: Record<string, unknown>;
};

/** Install the server's HTML and run the public chunk calls in delivery order. */
export async function streamPage(stream: ReadableStream<Uint8Array> | string): Promise<HTMLElement>
{
    const root = document.createElement('div');
    document.body.append(root);
    root.innerHTML = typeof stream === 'string' ? stream : await new Response(stream).text();
    azsRuntime();
    for (const template of root.querySelectorAll<HTMLTemplateElement>('template[data-azs]'))
    {
        host.__AZS!(Number(template.dataset.azs));
    }
    for (const script of root.querySelectorAll('script'))
    {
        script.remove();
    }
    return root;
}

export function clearStreamPage(): void
{
    for (const root of Array.from(document.body.children))
    {
        render(() => document.createElement('div'), root as HTMLElement);
        root.remove();
    }
    delete host.__AZS;
    delete host.__AZS_S;
}
