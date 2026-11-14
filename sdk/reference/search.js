const search = document.getElementById("search");
const groups = [...document.querySelectorAll(".nav-group")];
const index = new Map(window.pamatcadReference.map(entry => [entry.file, entry]));
const language = document.getElementById("language");
const current = index.get(document.querySelector('#entries [aria-current="page"]')?.getAttribute("href"));
const requestedLanguage = new URLSearchParams(location.search).get("language");
if (!current?.language && [...language.options].some(option => option.value === requestedLanguage)) {
  language.value = requestedLanguage;
}
// Carry the guide language through shared API pages, including when opened from disk.
const sharedQuery = language.value === "javascript" ? "" : "?language=" + encodeURIComponent(language.value);
if (sharedQuery) {
  for (const link of document.querySelectorAll("a[href]")) {
    const [file, anchor] = link.getAttribute("href").split("#");
    if (file === "index.html" || (index.has(file) && !index.get(file).language)) {
      link.href = file + sharedQuery + (anchor ? "#" + anchor : "");
    }
  }
}
language.addEventListener("change", () => {
  if (current?.language) {
    const guides = [...index.values()].filter(entry => entry.language === language.value);
    const next = guides.find(entry => entry.guidePath === current.guidePath) ?? guides[0];
    if (next) { location.assign(next.file); return; }
  }
  const url = new URL(current?.language ? "index.html" : location.href, location.href);
  if (language.value === "javascript") url.searchParams.delete("language");
  else url.searchParams.set("language", language.value);
  location.assign(url);
});

let best;
function filter() {
  const query = search.value.toLowerCase().trim();
  const words = query.split(/\s+/);
  let bestRank = Infinity;
  best = undefined;
  let total = 0;
  for (const group of groups) {
    let count = 0;
    for (const item of group.querySelectorAll("li")) {
      const link = item.firstElementChild;
      const file = link.getAttribute("href").split(/[?#]/)[0];
      const entry = index.get(file);
      if (entry.language && entry.language !== language.value) { item.hidden = true; continue; }
      const name = entry.name.toLowerCase();
      const field = query && entry.fields.find(f => words.every(w => f.path.toLowerCase().includes(w)));
      const text = entry.text.toLowerCase();
      const match = !query || words.every(w => name.includes(w) || text.includes(w)) || field;
      item.hidden = !match;
      link.href = file + (entry.language ? "" : sharedQuery) +
        (field && !name.includes(query) ? "#" + field.anchor : "");
      if (match) {
        count++;
        const rank = name === query ? 0 : name.startsWith(query) ? 1 : name.includes(query) ? 2 : field ? 3 : 4;
        if (rank < bestRank) { best = link; bestRank = rank; }
      }
    }
    group.hidden = count === 0;
    if (query && count) group.open = true;
    total += count;
  }
  document.getElementById("empty").hidden = total !== 0;
}
filter();
search.addEventListener("input", filter);
search.addEventListener("keydown", e => {
  if (e.key === "Enter") best?.click();
  if (e.key === "Escape") { search.value = ""; filter(); }
});
document.addEventListener("keydown", e => {
  if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    e.preventDefault();
    search.focus();
  }
});
