import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";

// Both sites are standalone directories. Check their complete link graphs before writing.
export function publish(directory, files) {
  const anchors = new Map();
  for (const [file, body] of files) {
    if (!file.endsWith(".html")) continue;
    const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    if (new Set(ids).size !== ids.length) throw new Error(file + ": duplicate HTML id");
    anchors.set(file, new Set(ids));
  }
  for (const [file] of anchors) {
    for (const [, href] of files.get(file).matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^https?:\/\/|^mailto:/i.test(href)) continue;
      const [path, fragment] = href.split("#");
      const target = path ? posix.join(posix.dirname(file), path) : file;
      if (!files.has(target) || (fragment && !anchors.get(target)?.has(fragment))) {
        throw new Error(file + ": broken link " + href);
      }
    }
  }
  const manifest = resolve(directory, ".generated.json");
  const previous = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : [];
  for (const [file, body] of files) {
    const path = resolve(directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  for (const file of previous) {
    if (typeof file !== "string" || file.split("/").some(part => !/^[\w.%-]+$/.test(part) || part === ".." || part === ".")) continue;
    if (!files.has(file) && existsSync(resolve(directory, file))) unlinkSync(resolve(directory, file));
  }
  writeFileSync(manifest, JSON.stringify([...files.keys()]) + "\n");
}
