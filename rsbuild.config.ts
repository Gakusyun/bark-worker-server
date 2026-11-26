import { defineConfig, type RsbuildConfig } from '@rsbuild/core';

const defines: Record<string, string> = {};

for (const key of [
  'URL_PREFIX',
  'MAX_BATCH_PUSH_COUNT',
  'DB_NAME',
  'ALLOW_NEW_DEVICE',
  'ALLOW_QUERY_NUMS',
  'BASIC_AUTH',
  'APNS_URL',
]) {
  defines[`process.env.${key}`] = process.env[key]
    ? JSON.stringify(process.env[key])
    : 'undefined';
}

const config: RsbuildConfig = {
  output: {
    target: 'web',
    module: true,
    distPath: {
      root: 'dist',
      js: '.',
    },
    filename: {
      js: '[name].js',
    },
    cleanDistPath: true,
    polyfill: 'off',
    sourceMap: false,
    minify: false,
  },
  performance: {
    chunkSplit: {
      strategy: 'all-in-one',
    },
  },
  source: {
    entry: {
      index: {
        import: './src/index.ts',
        html: false,
      },
    },
    define: defines,
  },
  tools: {
    rspack: {
      target: 'es2020',
      output: {
        asyncChunks: false,
        library: {
          type: 'module',
        },
      },
      experiments: {
        outputModule: true,
      },
    },
  },
};

// Docs: https://rsbuild.rs/config/
export default defineConfig(config);
