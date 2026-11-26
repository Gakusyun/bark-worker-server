import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig, type RsbuildConfig } from '@rsbuild/core';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));

const getGitCommit = () => {
  try {
    return execSync('git rev-parse HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
};

// e.g. 2026-11-26 12:34:56
const buildDate = new Date().toISOString().replace('T', ' ').slice(0, 19);

const defines: Record<string, string> = {
  __BUILD_VERSION__: JSON.stringify(pkg.version),
  __BUILD_DATE__: JSON.stringify(buildDate),
  __BUILD_COMMIT__: JSON.stringify(getGitCommit()),
};

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
