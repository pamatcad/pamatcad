import { defineConfig } from "vite";
import { globSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser } from "marked";
import { readSpec } from "../../tools/docs/spec.mjs";
import { startupTheme } from "./startup-theme";

const version = readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim();
const dependencies = readFileSync(new URL("../../native/occt/dependencies.cmake", import.meta.url), "utf8");
const occtVersion = dependencies.match(/set\(PAMATCAD_OCCT_VERSION\s+([^\s)]+)\)/)?.[1];
if (!occtVersion) throw new Error("Missing OCCT version in native/occt/dependencies.cmake");

const commandDir = fileURLToPath(new URL("../../doc/api/command/", import.meta.url));
const parser = new Parser();
const commandHelp = Object.fromEntries(globSync("**/spec.md", { cwd: commandDir }).sort().map(file => {
  const { title, sections } = readSpec(resolve(commandDir, file));
  const shortDescription = sections.get("Short Description")!.map(token => token.type === "paragraph" && token.tokens
    ? parser.parseInline(token.tokens, parser.textRenderer) : "text" in token ? token.text : "").join(" ").trim();
  return [dirname(file).split(sep).join("."), { name: title, shortDescription }];
}));

export default defineConfig(({ mode }) => ({
  plugins: [startupTheme()],
  base: "./",
  publicDir: mode === "desktop" ? false : "public",
  worker: { format: "es" },
  define: {
    __PAMATCAD_VERSION__: JSON.stringify(version),
    __OCCT_VERSION__: JSON.stringify(occtVersion),
    __PAMATCAD_COMMAND_HELP__: JSON.stringify(commandHelp),
  },
  build: {
    outDir: mode === "desktop" ? "../../build/desktop-ui" : "../../build/web",
    emptyOutDir: true,
  },
}));
