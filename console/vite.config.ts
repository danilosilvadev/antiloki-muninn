import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// strictPort is mandatory: the api's CORS allowlist is exactly :5177 —
// a silent port fallback would break every request invisibly.
export default defineConfig({
  plugins: [react()],
  server: { port: 5177, strictPort: true, host: '127.0.0.1' },
  preview: { port: 5177, strictPort: true, host: '127.0.0.1' },
});
