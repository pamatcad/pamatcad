import type { Plugin } from "vite";
import { lightTheme, themeVariables } from "./src/theme";

// The first HTML paint uses the same tokens as EditorTheme.apply(), before any
// JavaScript or geometry runtime has loaded.
export function startupTheme(): Plugin {
  return {
    name: "pamatcad-startup-theme",
    transformIndexHtml() {
      const declarations = themeVariables(lightTheme).map(([name, value]) => `${name}:${value}`);
      return [{
        tag: "style",
        attrs: { id: "startup-theme" },
        children: `:root{${declarations.join(";")}}`,
        injectTo: "head-prepend",
      }];
    },
  };
}
