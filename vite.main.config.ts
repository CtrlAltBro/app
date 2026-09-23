import { defineConfig, loadEnv } from 'vite';

// https://vitejs.dev/config
export default defineConfig(({ mode }) => {
  // Reads .env / .env.local (gitignored); a real env var still wins.
  const env = loadEnv(mode, process.cwd(), 'CTRLALTBRO_');
  return {
    define: {
      __API_URL__: JSON.stringify(env.CTRLALTBRO_API_URL || 'http://localhost:5173'),
    },
  };
});
