import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import path from 'path'

const isCapacitor = process.env.CAPACITOR === 'true';
const isNative = process.env.ELECTRON === 'true' || isCapacitor;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ...(isCapacitor ? [basicSsl()] : [])],
  envDir: path.resolve(__dirname, '..'),
  base: isNative ? './' : '/',
  server: {
    allowedHosts: true,
    ...(isCapacitor && {
      proxy: {
        '/api': {
          target: 'http://localhost:5000',
          changeOrigin: true,
        },
        '/hubs': {
          target: 'http://localhost:5000',
          changeOrigin: true,
          ws: true,
        },
      },
    }),
  },
})
