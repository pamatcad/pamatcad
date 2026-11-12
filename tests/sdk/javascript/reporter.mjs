import { dirname, relative, resolve, sep } from "node:path";
import { inspect } from "node:util";

const escape = value => String(value).replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const location = (data, name) => JSON.stringify([data.file, data.line, data.column, name]);

export default async function* report(source) {
  const rows = [];
  const captures = new Map();
  for await (const { type, data } of source) {
    if (type === "test:diagnostic" && data.message.startsWith("pamatcad-report ")) {
      const capture = JSON.parse(data.message.slice("pamatcad-report ".length));
      const key = location(data, capture.name);
      if (!captures.has(key)) captures.set(key, []);
      captures.get(key).push(capture);
    } else if (type === "test:pass" || type === "test:fail") {
      if (data.details.type === "suite" && type === "test:pass") continue;
      const status = data.skip ? "Skipped" : data.todo ? "Todo" : type === "test:pass" ? "Passed" : "Failed";
      rows.push({ data, status });
    }
  }

  const counts = Object.fromEntries(["Passed", "Failed", "Skipped", "Todo"].map(label =>
    [label, rows.filter(r => r.status === label).length]));
  const summary = Object.entries(counts).map(([label, count]) => `${count} ${label.toLowerCase()}`).join(" · ");
  yield `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PamatCAD SDK test report</title><style>
*{box-sizing:border-box}body{background:#f2f5f6;color:#1e3440;margin:0;font:16px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:auto;padding:32px 20px}h1{font-size:2rem;margin:0}header p{margin:.4rem 0 1.5rem}
article{background:white;border:1px solid #c8d3d9;border-radius:8px;margin:1rem 0;display:grid;grid-template-columns:minmax(240px,40%) 1fr;overflow:hidden}
section{padding:20px}h2{font-size:1.12rem;margin:.4rem 0}.meta{font-size:.85rem;color:#495e69}
.status{font-weight:650;color:#236645}.failed{color:#aa3325}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.85rem}
img{width:100%;height:auto;display:block}.image{align-self:center}.empty{color:#596c77;padding:20px}a{color:#0b6072}
@media(max-width:640px){article{grid-template-columns:1fr}}
</style><main><header><h1>SDK test report</h1><p>${escape(summary)}</p></header>`;
  for (const { data, status } of rows) {
    const capture = captures.get(location(data, data.name))?.shift();
    const base = capture && /^[\w-]+$/.test(capture.id) ? "assets/" + capture.id : undefined;
    const suite = data.file ? dirname(relative(resolve("tests/sdk/javascript/dist/api"), data.file)).split(sep).join("/") : "";
    const thumb = base && capture.jpeg
      ? `<a class="image" href="${base}.jpg"><img alt="Final scene for ${escape(data.name)}" src="${base}.jpg"></a>`
      : '<p class="empty">No scene snapshot</p>';
    yield `<article>${thumb}<section><div class="meta">${escape(suite)}</div><h2>${escape(data.name)}</h2>
<span class="status ${status === "Failed" ? "failed" : ""}">${status}</span> · ${Number(data.details.duration_ms ?? 0).toFixed(1)} ms
${base && capture.step ? `<p><a download href="${base}.step">Download STEP</a></p>` : ""}
${capture?.note ? `<p>${escape(capture.note)}</p>` : ""}
${data.details.error ? `<pre>${escape(inspect(data.details.error, { depth: 4, colors: false }))}</pre>` : ""}
</section></article>`;
  }
  yield "</main></html>\n";
}
