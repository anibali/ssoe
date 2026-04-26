import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'out'],
    setupFiles: [],
    // Mock the vscode module using jest-mock-vscode
    server: {
      deps: {
        inline: ['jest-mock-vscode'],
      },
    },
  },
});
