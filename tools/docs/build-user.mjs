import { existsSync, globSync, readFileSync } from "node:fs";
import { basename, dirname, extname, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { escape, readModel, variantKeys } from "../../sdk/reference/model.mjs";
import { publish } from "./output.mjs";
import { readSpec, readVariants } from "./spec.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const docs = resolve(root, "doc");
const commandDir = resolve(docs, "api/command");
const typeDir = resolve(docs, "api/type");
const model = readModel(resolve(root, "sdk/javascript/dist"));
const layout = readFileSync(resolve(here, "user.html"), "utf8");
const files = new Map([
  ["assets/guide.css", readFileSync(resolve(here, "user.css"))],
  ["assets/logo-letters.svg", readFileSync(resolve(docs, "media/logo-letters.svg"))],
]);
const home = resolve(docs, "user/index.md");
const pages = new Map([[home, "index.html"]]);
const specs = new Map();
const operations = [];

function spec(file) {
  if (!specs.has(file)) {
    const entry = readSpec(file);
    if (entry.sections.has("Variants")) {
      const type = model.byId.get("type/" + basename(dirname(file)));
      entry.variants = readVariants(file, entry.sections.get("Variants"), variantKeys(type?.node));
    }
    specs.set(file, entry);
  }
  return specs.get(file);
}
for (const file of globSync("**/spec.md", { cwd: commandDir }).sort()) {
  const parts = dirname(file).split(sep);
  const id = parts.join(".");
  if (!model.byId.has("command/" + id)) throw new Error("Unknown command " + id);
  const source = resolve(commandDir, file);
  const url = [...parts, "index.html"].join("/");
  const operation = { source, url, area: parts[0], ...spec(source) };
  for (const asset of ["icon", "illustration"]) {
    const path = resolve(dirname(source), asset + ".svg");
    if (existsSync(path)) {
      operation[asset] = posix.join(posix.dirname(url), asset + ".svg");
      files.set(operation[asset], readFileSync(path));
    }
  }
  pages.set(source, url);
  operations.push(operation);
}
const local = (from, to) => posix.relative(posix.dirname(from), to);
const slug = text => text.toLowerCase().trim().replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/\s+/g, "-");

function render(tokens, source, url, { choices = false, stack = [] } = {}) {
  if (!tokens?.length) return "";
  const renderer = new marked.Renderer();
  renderer.html = token => escape(token.text);
  renderer.heading = function (t) {
    return '<h' + t.depth + ' id="' + escape(slug(t.text)) + '">' + this.parser.parseInline(t.tokens) + '</h' + t.depth + '>';
  };
  function reference(href) {
    const [path, fragment] = href.split("#");
    const target = resolve(dirname(source), decodeURIComponent(path));
    if (!target.startsWith(docs + sep) || !existsSync(target)) throw new Error(source + ": unresolved link " + href);
    return { target, fragment };
  }
  renderer.link = function (t) {
    if (/^(https?:\/\/|mailto:|#)/i.test(t.href)) return marked.Renderer.prototype.link.call(this, t);
    const { target, fragment } = reference(t.href);
    if (!pages.has(target)) {
      if (extname(target) !== ".md") throw new Error(source + ": expected Markdown link " + t.href);
      const dest = target.startsWith(typeDir + sep) && basename(target) === "spec.md"
        ? "types/" + basename(dirname(target)) + "/index.html"
        : "topics/" + relative(docs, target).split(sep).join("/").slice(0, -3) + "/index.html";
      pages.set(target, dest);
    }
    const href = local(url, pages.get(target)) + (fragment ? "#" + fragment : "");
    return marked.Renderer.prototype.link.call(this, { ...t, href });
  };
  // A standalone link to a type's variants in parameter prose expands its choices in place.
  renderer.paragraph = function (t) {
    const link = t.tokens.length === 1 && t.tokens[0];
    if (!choices || link?.type !== "link" || !link.href.endsWith("#variants") || link.href.startsWith("#") || /^\w+:/.test(link.href)) {
      return marked.Renderer.prototype.paragraph.call(this, t);
    }
    const { target } = reference(link.href);
    if (stack.includes(target)) throw new Error(source + ": cyclic variant inclusion " + link.href);
    const variants = spec(target).variants;
    if (!variants?.length) throw new Error(source + ": no documented variants at " + link.href);
    const title = this.parser.parseInline(link.tokens);
    const label = stack.length ? '<p class="group-label">' + title + '</p>' : "";
    return label + variants.map(v => '<details class="choice"><summary>' + escape(v.label) + '</summary><div>' +
      render(v.body, target, url, { choices, stack: [...stack, target] }) + '</div></details>').join("");
  };
  return marked.parser(tokens, { renderer });
}
function writePage(url, title, content) {
  const toRoot = posix.relative(posix.dirname(url), ".");
  const values = { root: toRoot ? toRoot + "/" : "", title: escape(title), content };
  files.set(url, layout.replace(/\{\{(root|title|content)\}\}/g, (_, key) => values[key]));
}

const homeTokens = marked.lexer(readFileSync(home, "utf8"));
function card(op) {
  const icon = op.icon ? '<img width="32" height="32" src="' + escape(op.icon) + '" alt="">' : "";
  const art = op.illustration ? '<img class="card-art" width="512" height="256" src="' + escape(op.illustration) + '" alt="">' : "";
  return '<div class="card"><div class="card-copy">' + icon + '<h3><a href="' + escape(op.url) + '">' +
    escape(op.title) + ' <span aria-hidden="true">→</span></a></h3>' +
    render(op.sections.get("Short Description"), op.source, "index.html") + '</div>' + art + '</div>';
}
const homeBody = homeTokens.map(t => {
  const marker = t.type === "html" && /^<!--\s*commands:\s*([\w-]+)\s*-->$/.exec(t.raw.trim());
  return marker ? '<div class="catalog">' + operations.filter(op => op.area === marker[1]).map(card).join("") + '</div>'
    : render([t], home, "index.html");
}).join("");
const homeTitle = homeTokens.find(t => t.type === "heading" && t.depth === 1)?.text;
if (!homeTitle) throw new Error(home + ": missing page title");
writePage("index.html", homeTitle, '<article class="landing">' + homeBody + '</article>');

for (const op of operations) {
  const { source, url, title, sections } = op;
  const back = local(url, "index.html");
  const icon = op.icon ? '<img class="command-icon" width="32" height="32" src="' + escape(local(url, op.icon)) + '" alt="">' : "";
  const figure = op.illustration ? '<figure><img width="512" height="256" src="' + escape(local(url, op.illustration)) +
    '" alt="' + escape(title + ' illustration') + '"></figure>' : "";
  const header = '<header class="operation-head"><div>' + icon + '<h1>' + escape(title) + '</h1><div class="lead">' +
    render(sections.get("Short Description"), source, url) + '</div></div>' + figure + '</header>';
  const description = sections.get("Description");
  const first = description.findIndex(t => t.type !== "space");
  const more = render(description.slice(first + 1), source, url).trim();
  let body = '<section id="description"><h2>Description</h2>' + render([description[first]], source, url) +
    (more ? '<details class="fold"><summary>Full description</summary>' + more + '</details>' : "") + '</section>';
  const parameters = resolve(dirname(source), "user-parameters.md");
  if (existsSync(parameters)) {
    body += '<section id="parameters"><h2>Parameters</h2>' +
      render(marked.lexer(readFileSync(parameters, "utf8")), parameters, url, { choices: true }) + '</section>';
  }
  if (sections.get("Topology")?.some(t => t.type !== "space")) {
    body += '<section id="topology"><h2>Topology</h2><details class="fold"><summary>Face selection details</summary>' +
      render(sections.get("Topology"), source, url) + '</details></section>';
  }
  writePage(url, title, '<article><a class="back" href="' + back + '">← User guide</a>' + header + body + '</article>');
}
// Linked documents are added as they are encountered, including links from other topics.
for (const [source, url] of pages) {
  if (files.has(url)) continue;
  let title, body;
  if (source.startsWith(typeDir + sep) && basename(source) === "spec.md") {
    const entry = spec(source);
    title = entry.title;
    body = '<h1>' + escape(title) + '</h1>' + [...entry.sections].filter(([key]) => key !== "Name").map(([key, tokens]) =>
      '<section id="' + slug(key) + '"><h2>' + escape(key) + '</h2>' + render(tokens, source, url) + '</section>').join("");
  } else {
    const tokens = marked.lexer(readFileSync(source, "utf8"));
    title = tokens.find(t => t.type === "heading" && t.depth === 1)?.text;
    if (!title) throw new Error(source + ": missing page title");
    body = render(tokens, source, url);
  }
  writePage(url, title, '<article class="topic"><a class="back" href="' + local(url, "index.html") + '">← User guide</a>' + body + '</article>');
}

const out = resolve(root, "build/user-docs");
publish(out, files);
console.log("Built " + operations.length + " operation(s) in build/user-docs/index.html");
