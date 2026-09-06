import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

export default defineConfig({
  plugins: [pluginReact()],
  source: {
    entry: {
      index: './src/main.tsx',
    },
  },
  server: {
    port: 5199,
    historyApiFallback: true,
  },
  output: {
    distPath: {
      root: 'dist',
    },
  },
});
