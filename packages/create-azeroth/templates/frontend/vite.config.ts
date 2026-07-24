import { azeroth } from '@azerothjs/compiler';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [azeroth()],
    test: {
        environment: 'happy-dom'
    }
});
