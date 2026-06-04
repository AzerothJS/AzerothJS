#!/usr/bin/env node
// Binary entry point. Editors launch this with `--stdio` (or over IPC); it
// creates the standard LSP connection and starts the server. Kept to a single
// call so all behaviour lives in the testable `startServer`.

import { startServer } from './server.ts';

startServer();
