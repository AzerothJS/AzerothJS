// ============================================================================
// AZEROTHJS — Demo Entry
// ============================================================================
//
// A router-driven, component-based showcase of the whole framework.
// The route table and shared router live in ./router.ts; the
// persistent layout is ./shell.ts; each section is a page component
// under ./pages/.
//
// Run: npx vite demo
// ============================================================================

import { render } from '@azerothjs/core';
import { AppShell } from './shell.ts';

render(() => AppShell({}), document.getElementById('app')!);
