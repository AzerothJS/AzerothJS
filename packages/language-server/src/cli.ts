#!/usr/bin/env node
/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Binary entry point. Editors launch this with `--stdio` (or over IPC); it
// creates the standard LSP connection and starts the server. Kept to a single
// call so all behaviour lives in the testable `startServer`.

import { startServer } from './server.ts';

startServer();
