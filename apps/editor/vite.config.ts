import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { startupTheme } from "./startup-theme";

const version = readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim();
const dependencies = readFileSync(new URL("../../native/occt/dependencies.cmake", import.meta.url), "utf8");
const occtVersion = dependencies.match(/set\(PAMATCAD_OCCT_VERSION\s+([^\s)]+)\)/)?.[1];
if (!occtVersion) throw new Error("Missing OCCT version in native/occt/dependencies.cmake");

export default defineConfig(({ mode }) => ({
  plugins: [startupTheme()],
  base: "./",
  publicDir: mode === "desktop" ? false : "public",
  worker: { format: "es" },
  define: {
    __PAMATCAD_VERSION__: JSON.stringify(version),
    __OCCT_VERSION__: JSON.stringify(occtVersion),
  },
  build: {
    outDir: mode === "desktop" ? "../../build/desktop-ui" : "../../build/web",
    emptyOutDir: true,
  },
}));
