import { globSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { readModel, escape } from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const docs = resolve(root, "doc");
const source = resolve(docs, "api");
const out = resolve(root, "sdk/docs");
const model = readModel(resolve(root, "sdk/javascript/dist"));
const groups = { guide: "Guides", command: "Commands", class: "Classes", type: "Types", function: "Supporting declarations" };
const requiredSections = ["Name", "Short Description", "Description"];
const sectionNames = [...requiredSections, "Topology"];
const bySource = new Map();
const languages = new Map([["javascript", "JavaScript"]]);

for (const file of globSync("**/spec.md", { cwd: source }).sort()) {
  const [kind, ...parts] = file.split(sep).slice(0, -1);
  if (!Object.hasOwn(groups, kind) || kind === "guide" || !parts.length) throw new Error("Unknown API spec path: " + file);
  const name = parts.join(".");
  const page = model.byId.get(kind + "/" + name) ?? model.add(kind, name);
  const sections = new Map();
  let current;
  for (const token of marked.lexer(readFileSync(resolve(source, file), "utf8"))) {
    if (token.type === "heading" && (token.depth === 1 || token.text.toLowerCase() === "test cases")) {
      current = sectionNames.find(s => s.toLowerCase() === token.text.toLowerCase());
      if (current) {
        if (sections.has(current)) throw new Error(file + ": duplicate " + current);
        sections.set(current, []);
      }
    } else if (current) sections.get(current).push(token);
  }
  for (const section of requiredSections) {
    if (!sections.get(section)?.some(t => t.type !== "space")) throw new Error(file + ": missing or empty " + section);
  }
  page.sections = sections;
  page.title = sections.get("Name").map(t => t.text ?? "").join(" ").trim();
  page.spec = resolve(source, file);
  bySource.set(page.spec, page);
  if (kind === "command" && !page.input) throw new Error(file + ": command missing from the core protocol: " + name);
}
function addGuide(sourceFile, path, language) {
  const tokens = marked.lexer(readFileSync(sourceFile, "utf8"));
  const heading = tokens.find(t => t.type === "heading" && t.depth === 1);
  if (!heading) throw new Error(sourceFile + ": guide needs a # title");
  const segments = path.split("/");
  if (language) segments.unshift(language);
  const page = model.add("guide", heading.text, relative(root, sourceFile).split(sep).join("/"));
  // Keep nested guide paths in one portable filename, including spaces and Unicode.
  const key = segments.map(part =>
    part.replace(/[^a-zA-Z0-9-]/gu, ch => "_" + ch.codePointAt(0).toString(16) + "_")).join(".");
  page.file = (language ? "guide-" : "doc-") + key + ".html";
  page.spec = sourceFile;
  page.language = language;
  page.guidePath = path;
  page.tokens = tokens;
  bySource.set(sourceFile, page);
  return page;
}
const sdk = resolve(root, "sdk");
for (const file of globSync("*/docs/**/*.md", { cwd: sdk }).sort()) {
  const [language, , ...parts] = file.split(sep);
  addGuide(resolve(sdk, file), parts.join("/").slice(0, -3), language);
  if (!languages.has(language)) languages.set(language, language[0].toUpperCase() + language.slice(1));
}

function prose(page, tokens) {
  if (!tokens) return "";
  marked.walkTokens(tokens, t => {
    if (t.type !== "link" || /^https?:\/\/|^mailto:/i.test(t.href)) return;
    const [file, fragment] = t.href.split("#");
    const target = file ? resolve(dirname(page.spec), decodeURIComponent(file)) : page.spec;
    let to = bySource.get(target);
    if (!to && target.startsWith(docs + sep) && target.endsWith(".md") && existsSync(target)) {
      to = addGuide(target, relative(docs, target).split(sep).join("/").slice(0, -3));
    }
    if (!to) throw new Error(page.spec + ": unresolved documentation link " + t.href);
    t.href = to.file + (fragment ? "#" + fragment : "");
    if (page !== to) to.uses.add(page);
  });
  const renderer = new marked.Renderer();
  renderer.html = t => escape(t.text);
  renderer.heading = function (t) {
    const id = t.text.toLowerCase().trim().replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/\s+/g, "-");
    return '<h' + t.depth + ' id="' + escape(id) + '">' + this.parser.parseInline(t.tokens) + '</h' + t.depth + '>\n';
  };
  return marked.parser(tokens, { renderer });
}
function section(id, title, content) {
  return content ? '<section id="' + id + '"><h2>' + title + '</h2>' + content + '</section>' : "";
}
function codeBlocks(signatures) {
  return signatures.map(s => '<pre><code>' + s + '</code></pre>').join("");
}
for (const p of model.pages) {
  if (p.kind === "guide") {
    const label = p.language ? languages.get(p.language) + " guide" : "Guide";
    p.body = '<div class="guide"><div class="entry-kind">' + escape(label) + '</div>' + prose(p, p.tokens) + '</div>';
    continue;
  }
  const short = prose(p, p.sections?.get("Short Description"));
  const description = prose(p, p.sections?.get("Description"));
  const topology = prose(p, p.sections?.get("Topology"));
  const title = p.title ?? p.name;
  const category = p.kind === "function" || p.support ? "Supporting declaration" :
    { command: "Command", class: "Class", type: "Type" }[p.kind];
  const links = [];
  if (description) links.push(["description", "Description"]);
  if (topology) links.push(["topology", "Topology"]);
  if (p.input) links.push(["signature", "JavaScript"], ["parameters", "Parameters"], ["result", "Result"]);
  else if (p.node) links.push(["definition", p.kind === "class" ? "Public members" : "Definition"]);
  const outline = links.length > 1 ? '<nav class="outline" aria-label="On this page">' + links.map(
    ([id, label]) => '<a href="#' + id + '">' + label + '</a>').join("") + '</nav>' : "";
  const heading = '<header class="entry-heading"><div class="entry-kind">' + category + '</div><h1>' +
    escape(title) + '</h1>' + (title !== p.name ? '<code class="entry-id">' + escape(p.name) + '</code>' : "") +
    (short ? '<div class="summary" id="short-description">' + short + '</div>' : "") + outline + '</header>';
  let reference = "";
  if (p.input) {
    reference += section("signature", "JavaScript", codeBlocks(model.binding(p)));
    reference += section("parameters", "Request parameters", '<code class="root-type">' + model.syntax(p, p.input) +
      '</code>' + model.parameterTree(p));
    reference += section("result", "Result", codeBlocks([model.syntax(p, p.output)]));
  } else if (p.node) {
    reference += section("definition", p.kind === "class" ? "Public members" : "Definition", model.declaration(p));
  }
  p.body = heading + section("description", "Description", description) + section("topology", "Topology", topology) + reference;
}
model.pages.sort((a, b) => Number(!!b.spec) - Number(!!a.spec) || a.name.localeCompare(b.name, "en"));

const navigation = (current) => Object.entries(groups).map(([kind, label]) => {
  const items = model.pages.filter(p => p.kind === kind).map(p =>
    '<li' + (p.language && p.language !== (current.language ?? "javascript") ? ' hidden' : '') +
    '><a href="' + escape(p.file) + '"' + (p === current ? ' aria-current="page"' : "") + '>' + escape(p.label) + '</a></li>');
  return items.length ? '<details open class="nav-group"><summary>' + label + '</summary><ul>' + items.join("") + '</ul></details>' : "";
}).join("");
const version = JSON.parse(readFileSync(resolve(root, "sdk/javascript/package.json"))).version;
function layout(p) {
  const used = [...p.uses].sort((a, b) => a.name.localeCompare(b.name, "en")).map(a =>
    '<a href="' + escape(a.file) + '">' + escape(a.label) + '</a>').join("");
  const options = [...languages].map(([id, label]) =>
    '<option value="' + escape(id) + '"' + (id === (p.language ?? "javascript") ? ' selected' : '') + '>' + escape(label) + '</option>').join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(p.name)} · PamatCAD SDK</title><link rel="stylesheet" href="reference.css">
<script defer src="search-index.js"></script><script defer src="search.js"></script></head>
<body><a class="skip" href="#content">Skip to reference</a>
<header class="mast"><a href="index.html" class="brand"><img src="logo-letters.svg" alt="PamatCAD" width="162" height="54"></a><span class="product">SDK reference</span>
<div class="preferences"><span class="version">v${escape(version)}</span><label>Language <select id="language" aria-label="SDK language">${options}</select></label></div></header>
<div class="workspace"><aside><div class="find"><label for="search">Search reference</label>
<div class="search-box"><input type="search" id="search" placeholder="Command, type, or field…" autocomplete="off" aria-controls="entries"><kbd>/</kbd></div></div>
<nav aria-label="API entries" id="entries">${navigation(p)}</nav><p id="empty" hidden role="status">No matching entries.</p></aside>
<main id="content"><article>${p.body}${section("used-by", "Referenced by", used ? '<div class="backlinks">' + used + '</div>' : "")}</article></main></div></body></html>\n`;
}
const files = new Map();
const landing = model.pages.find(p => p.spec && p.kind === "command") ?? model.pages[0];
for (const p of model.pages) files.set(p.file, layout(p));
files.set("index.html", files.get(landing.file));
for (const name of ["search.js", "reference.css"]) files.set(name, readFileSync(resolve(here, name), "utf8"));
files.set("logo-letters.svg", readFileSync(resolve(docs, "media/logo-letters.svg")));
const search = model.pages.map(p => ({
  name: p.name, file: p.file, title: p.title ?? p.name,
  text: p.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  fields: p.fields, language: p.language, guidePath: p.guidePath,
}));
// A classic script keeps search available under file:// as well as HTTP.
files.set("search-index.js", "window.pamatcadReference = " + JSON.stringify(search) + ";\n");

// Check the complete link graph before publishing any page, including fragment links.
const anchors = new Map([...files].filter(([name]) => name.endsWith(".html")).map(([name, html]) => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  if (new Set(ids).size !== ids.length) throw new Error(name + ": duplicate HTML id");
  return [name, new Set(ids)];
}));
for (const [file] of anchors) {
  for (const [, href] of files.get(file).matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^https?:\/\/|^mailto:/i.test(href)) continue;
    const [target, fragment] = href.split("#");
    if (!files.has(target || file) || (fragment && !anchors.get(target || file)?.has(fragment))) {
      throw new Error(file + ": broken link " + href);
    }
  }
}
mkdirSync(out, { recursive: true });
const manifest = resolve(out, ".generated.json");
const previous = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : [];
for (const [name, body] of files) writeFileSync(resolve(out, name), body);
for (const name of previous) {
  if (/^[\w.%-]+$/.test(name) && !files.has(name) && existsSync(resolve(out, name))) unlinkSync(resolve(out, name));
}
writeFileSync(manifest, JSON.stringify([...files.keys()]) + "\n");
console.log(`Built ${model.pages.length} entries in ${relative(root, out)}/index.html`);
