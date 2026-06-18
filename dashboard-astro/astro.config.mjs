// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

// Dashboard servido por un servidor Node local (systemd) en 127.0.0.1:4319.
// `output: server` para poder leer el JSON de métricas en vivo vía una API route.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  server: { host: '127.0.0.1', port: 4319 },
  devToolbar: { enabled: false },
});
