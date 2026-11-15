import { readFileSync } from "node:fs";
import { marked } from "marked";

const required = ["Name", "Short Description", "Description"];
const published = [...required, "Topology", "Variants"];

export function readSpec(file) {
  const sections = new Map();
  let current;
  for (const token of marked.lexer(readFileSync(file, "utf8"))) {
    if (token.type === "heading" && (token.depth === 1 || token.text.toLowerCase() === "test cases")) {
      current = published.find(name => name.toLowerCase() === token.text.toLowerCase());
      if (current) {
        if (sections.has(current)) throw new Error(file + ": duplicate " + current);
        sections.set(current, []);
      }
    } else if (current) sections.get(current).push(token);
  }
  for (const name of required) {
    if (!sections.get(name)?.some(t => t.type !== "space")) throw new Error(file + ": missing or empty " + name);
  }
  const title = sections.get("Name").map(t => t.text ?? "").join(" ").trim();
  return { title, sections };
}

export function readVariants(file, tokens, keys) {
  const variants = new Map();
  let body;
  for (const token of tokens) {
    if (token.type === "heading" && token.depth === 2) {
      const heading = /^`([^`]+)`\s+—\s+(.+)$/.exec(token.text);
      if (!heading) throw new Error(file + ": expected a variant key and label in " + token.raw.trim());
      const [, key, label] = heading;
      if (!keys.includes(key) || variants.has(key)) throw new Error(file + ": unknown or duplicate variant " + key);
      body = [];
      variants.set(key, { key, label, body });
    } else if (body) body.push(token);
    else if (token.type !== "space") throw new Error(file + ": variant text needs a heading");
  }
  for (const key of keys) {
    if (!variants.get(key)?.body.some(t => t.type !== "space")) throw new Error(file + ": missing description for " + key);
  }
  return [...variants.values()];
}
