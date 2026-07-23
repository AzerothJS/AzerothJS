import { azeroth } from '@azerothjs/compiler';
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [azeroth()],
    server:
    {
        proxy:
        {
            // The server half of this app. `azeroth dev` runs both halves; this line is
            // the whole wiring - static, visible, yours to change.
            '/api': 'http://localhost:3000'
        }
    }
});
