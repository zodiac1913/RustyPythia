import { defineConfig } from "vite";
import packageJson from "./package.json";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [{
    name: "app-version",
    transformIndexHtml(html) {
      return html.replaceAll("%APP_VERSION%", packageJson.version);
    },
  }],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // The AI window is its own page, so both entry points have to be built.
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        ai: "ai.html",
      },
    },
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
