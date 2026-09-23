// The two stores the boot arm enters, read through a global so the spec and vite's copy agree.
interface Store
{
    getStore(): string | undefined;
}

export function storesSeen(): string
{
    const stores = (globalThis as { __azerothDevStores?: { boot: Store; visitor: Store } }).__azerothDevStores;
    return `db=${ stores?.boot.getStore() ?? 'none' }|me=${ stores?.visitor.getStore() ?? 'none' }`;
}
