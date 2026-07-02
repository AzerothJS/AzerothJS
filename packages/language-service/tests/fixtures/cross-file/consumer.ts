// A plain TypeScript module that uses helpers.ts but is imported by NOTHING - it only enters the
// program as a project ROOT (tsconfig include). Guards that editor-mode services constructed with
// `rootProjectFiles: true` (as the language server does) surface `.ts`-only usages in
// find-references and rename; without rooting, this file is invisible and a rename would silently
// leave it stale. Used by ../cross-file.spec.ts.

import { defaultUser, greet } from './helpers';

export const consumerGreeting: string = greet(defaultUser);
