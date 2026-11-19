import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  base: "./",
  publicDir: mode === "desktop" ? false : "public",
  worker: { format: "es" },
  build: {
    outDir: mode === "desktop" ? "../../build/desktop-ui" : "../../build/web",
    emptyOutDir: true,
  },
}));
