/**
 * Vite build configuration for the Phantom Agent Chrome Extension.
 *
 * MULTI-ENTRY BUILD
 * -----------------
 * Chrome extensions cannot use dynamic imports that cross entry-point
 * boundaries (each HTML page and the background service worker are separate
 * isolated contexts with no shared module registry). We therefore:
 *
 * 1. Disable code splitting entirely (manualChunks: undefined).
 * 2. Declare each entry point explicitly in rollupOptions.input.
 * 3. Output a flat dist/ directory so Chrome can locate all assets without
 *    sub-path configuration.
 *
 * Entries:
 *   sidepanel.html  → Side panel UI (full-height)
 *   popup.html      → Popup UI (400×600px)
 *   background.ts   → Service worker (no HTML wrapper)
 *
 * UNDERSCORE PREFIX FIX
 * ---------------------
 * Chrome extensions reject any file whose name starts with "_" — they are
 * reserved for internal browser use. Rollup sometimes generates helper chunk
 * names like "_basePickBy-xxxx.js". The `sanitizeFileName` hook strips any
 * leading underscores from every output filename before it is written.
 *
 * ENV VARIABLES (required in apps/web/.env)
 * -----------------------------------------
 *   VITE_CONVEX_URL          Convex deployment URL
 *   VITE_CONVEX_SITE_URL     Convex HTTP actions URL
 *   VITE_PHANTOM_APP_ID      Your Phantom Portal application ID
 */

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

/**
 * Strips leading underscores from filenames so Chrome does not reject them.
 * Rollup internal helpers (e.g. _basePickBy-xxxx.js) hit this rule.
 */
function sanitizeFileName(name: string): string {
  // Remove every leading underscore, preserving the rest of the name.
  return name.replace(/^_+/, "chunk-");
}

export default defineConfig({
  plugins: [tailwindcss(), react()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  build: {
    outDir: "dist",
    emptyOutDir: true,

    rollupOptions: {
      input: {
        sidepanel: path.resolve(__dirname, "sidepanel.html"),
        popup: path.resolve(__dirname, "popup.html"),
        background: path.resolve(__dirname, "src/background.ts"),
      },

      output: {
        // Flat output — no sub-directories.
        entryFileNames: "[name].js",
        chunkFileNames: "[name]-[hash].js",
        assetFileNames: "[name]-[hash][extname]",

        // No cross-entry code splitting.
        manualChunks: undefined,

        // Strip leading underscores from every generated filename.
        sanitizeFileName,
      },
    },

    sourcemap: true,
    target: "esnext",
  },

  server: {
    port: 3001,
  },

  define: {
    "process.env.VITE_PHANTOM_APP_ID": JSON.stringify(
      process.env.VITE_PHANTOM_APP_ID ?? "",
    ),
    "process.env.VITE_CONVEX_SITE_URL": JSON.stringify(
      process.env.VITE_CONVEX_SITE_URL ?? "",
    ),
  },
});
