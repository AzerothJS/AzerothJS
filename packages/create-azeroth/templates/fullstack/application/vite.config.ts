import { azeroth } from '@azerothjs/compiler';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [azeroth()],
    server:
    {
        proxy:
        {
            // The server half of this app. `azeroth dev` runs both halves; this line is
            // the whole DEV wiring. In production the server serves the built client
            // itself (one origin) - see server/src/app.ts.
            '/api': 'http://localhost:3000'
        }
    },
    test:
    {
        environment: 'happy-dom'
    }
});
