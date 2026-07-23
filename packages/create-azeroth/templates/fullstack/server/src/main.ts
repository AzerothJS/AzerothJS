// The server half. No build step: Node >= 24 runs this file directly, and `azeroth dev`
// (from the project root) watches it alongside the vite app. Routes live under /api -
// the same prefix the application's vite proxy forwards.
import { App, serve, handleShutdownSignals, json } from '@azerothjs/http';

const app = new App({ dev: process.env.NODE_ENV !== 'production' });

app.get('/api/health', () => json({ ok: true, at: new Date().toISOString() }));

const served = await serve(app, { port: Number(process.env.PORT) || 3000 });
handleShutdownSignals(served); // SIGTERM/SIGINT: drain in-flight responses, then exit
