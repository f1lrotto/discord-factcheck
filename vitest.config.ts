import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/types.ts'],
      thresholds: {
        statements: 90,
        branches: 75,
        functions: 90,
        lines: 90,
        'src/security.ts': { statements: 88, branches: 82, functions: 100, lines: 90 },
        'src/openrouter.ts': { statements: 90, branches: 75, functions: 90, lines: 92 },
        'src/jolanda.ts': { statements: 90, branches: 80, functions: 90, lines: 92 },
        'src/mongo-accounting.ts': {
          statements: 90,
          branches: 68,
          functions: 85,
          lines: 90,
        },
        'src/mongo-settings.ts': { statements: 85, branches: 60, functions: 100, lines: 90 },
        'src/discord-response.ts': { statements: 80, branches: 60, functions: 85, lines: 85 },
      },
    },
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 60_000,
  },
});
