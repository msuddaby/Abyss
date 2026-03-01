import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import path from 'path'

const isCapacitor = process.env.CAPACITOR === 'true';
const isNative = process.env.ELECTRON === 'true' || isCapacitor;

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    ...(isCapacitor ? [basicSsl()] : []),
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      disable: !process.env.SENTRY_AUTH_TOKEN,
    }),
  ],
  build: {
    sourcemap: true,
  },
  envDir: path.resolve(__dirname, '..'),
  base: isNative ? './' : '/',
  server: {
    allowedHosts: true,
    proxy: {
      '/api/sentry-tunnel': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
      ...(isCapacitor && {
        '/api': {
          target: 'http://localhost:5000',
          changeOrigin: true,
        },
        '/hubs': {
          target: 'http://localhost:5000',
          changeOrigin: true,
          ws: true,
        },
      }),
    },
  },
})
