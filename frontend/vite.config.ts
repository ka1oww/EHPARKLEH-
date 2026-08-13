import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split React into its own long-lived chunk so app-code changes don't
        // bust the (large, rarely-changing) framework cache. Leaflet lands in
        // its own chunk automatically via the lazy import in App.tsx.
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'vendor-react'
        },
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'brand-car.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'EhParkLeh',
        short_name: 'EhParkLeh',
        description: 'Find parking near you in Singapore, right now.',
        theme_color: '#1E1B4B',
        background_color: '#F5F6FB',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'icons/pwa-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/pwa-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Offline app-shell: precache the built assets so the UI loads with no
        // network. Search API responses are deliberately not cached here: App's
        // saved-results path labels them explicitly instead of replaying an old
        // response that hides an upstream failure or claims stale data is live.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // Google Fonts stylesheet: refresh in the background, serve from
            // cache instantly (and offline).
            urlPattern: ({ url }) => url.hostname === 'fonts.googleapis.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-stylesheets' },
          },
          {
            // Google Fonts woff2 files: immutable, cache for a year so they load
            // offline and never refetch. Fixes fonts failing offline before.
            urlPattern: ({ url }) => url.hostname === 'fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: {
                maxEntries: 30,
                maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Stadia Maps basemap tiles for the Leaflet map. Cached on demand as
            // the user pans (not pre-seeded), so the last-viewed area survives
            // offline.
            urlPattern: ({ url }) => url.hostname.endsWith('tiles.stadiamaps.com'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 60 * 60 * 24 * 7, // 1 week
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
})
