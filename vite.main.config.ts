import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  define: {
    __API_URL__: JSON.stringify(process.env.CTRLALTBRO_API_URL ?? 'http://localhost:5173'),
  },
});
