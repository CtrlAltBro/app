// Bundles the core + service entry into one file for plain Node (no Electron).
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { loadEnv } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// Same API URL as the Electron build: .env / .env.local, a real env var wins.
const env = loadEnv('development', process.cwd(), 'CTRLALTBRO_');

await build({
  entryPoints: ['src/service/main.ts'],
  outfile: '.service/service.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'warning',
  define: {
    __API_URL__: JSON.stringify(env.CTRLALTBRO_API_URL || 'http://localhost:5173'),
    __APP_VERSION__: JSON.stringify(version),
  },
});
console.log('[build] service → .service/service.js');
