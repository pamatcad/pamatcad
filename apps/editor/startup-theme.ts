import type { Plugin } from "vite";
import { lightTheme } from "./src/theme";

// The first HTML paint uses the same tokens as EditorTheme.apply(), before any
// JavaScript or geometry runtime has loaded.
export function startupTheme(): Plugin {
  return {
    name: "pamatcad-startup-theme",
    transformIndexHtml() {
      const declarations = Object.entries(lightTheme).flatMap(([group, tokens]) =>
        Object.entries(tokens).map(([name, value]) => {
          const key = name.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
          return `--${key}${group === "opacity" ? "-opacity" : ""}:${value}`;
        }),
      );
      return [{
        tag: "style",
        attrs: { id: "startup-theme" },
        children: `:root{${declarations.join(";")}}`,
        injectTo: "head-prepend",
      }];
    },
  };
}
