import { azeroth } from '@azerothjs/compiler';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [azeroth(), tailwindcss()],
    server: {
        // Declared rather than inherited, so the port this app serves on is one visible
        // line you can change. Vite still steps to the next free port if it is taken.
        port: 5173
    },
    test: {
        environment: 'happy-dom'
    }
});
