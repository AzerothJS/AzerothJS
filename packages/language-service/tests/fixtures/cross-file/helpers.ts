// A plain TypeScript module imported by a `.azeroth` component, to exercise cross-file intelligence
// (completion / hover / definition / references / rename / type errors) across the `.ts` ↔ `.azeroth`
// boundary. Used by ../cross-file.spec.ts.

export interface User
{
    id: number;
    name: string;
}

export const defaultUser: User = { id: 1, name: 'Ana' };

export function greet(user: User): string
{
    return 'Hello, ' + user.name;
}
