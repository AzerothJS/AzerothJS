// Fixture: a plain `.ts` module the sibling `.azeroth` component imports, so the
// combined azeroth-tsc program exercises the `.ts` <-> `.azeroth` boundary.

/** Formats a gold amount for display. */
export function formatGold(amount: number): string
{
    return `${ amount }g`;
}
