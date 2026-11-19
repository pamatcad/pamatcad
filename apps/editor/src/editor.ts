import "./style.css";
import wordmarkUrl from "../../../doc/media/logo-letters.svg?url";
import faviconUrl from "../../../doc/media/logo.svg?url";
import extrudeIconUrl from "../../../doc/api/command/solid/extrude/icon.svg?url";
import { Core, type Scene, type RegionRef, type BodyProxy, type TimelineEntry } from "@pamatcad/sdk";
import { editorTransport } from "./runtime/transport";
import { appendOutput, initOutputDock, logCommand, setConsoleEnabled, updateSceneTree } from "./dock";
import { Viewport, type Point, type Rectangle, type TopologyPick } from "./viewport";
import { initSceneBrowser } from "./scene-browser";
import { editorTheme } from "./theme";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => el<HTMLButtonElement>(id);
const input = (id: string) => el<HTMLInputElement>(id);
const message = (value: unknown) => (value instanceof Error ? value.message : String(value));
const desktop = import.meta.env.MODE === "desktop";
let scene: Scene;
let viewport: Viewport;
let entries: TimelineEntry[] = [];
const rectangles = new Map<string, Rectangle>();
const regions = new Map<string, RegionRef>();
const proxies = new Map<string, BodyProxy>();
let selectedSketch: string | undefined;
let selectedBody: string | undefined;
let selectedTopology: { pick: TopologyPick; revision: string } | undefined;
let objectTab: "Components" | "Construction" | "Bodies" | "Sketches" = "Bodies";
let tool: "sketch" | "extrude" | undefined;
let busy = false;
let anchor: Point | undefined;
let drawing = false;
let revision = 0;
let timer: ReturnType<typeof setTimeout>;
let pendingPreview = false;
let renderedLength: string | undefined;
let fitFirstPreview = false;
const status = (text: string) => {
  el("status").textContent = text;
};

const transport = editorTransport(logCommand);
const core = new Core(transport);

function controls() {
  button("new-sketch").disabled = busy || !scene || !!tool;
  button("extrude").disabled = busy || !selectedSketch || !!tool;
  for (const [id, name] of [
    ["new-sketch", "sketch"],
    ["extrude", "extrude"],
  ]) {
    button(id).setAttribute("aria-pressed", String(tool === name));
  }
  el("progress").hidden = !busy && !pendingPreview;
  setConsoleEnabled(!busy && !!scene && !tool);
  button("menu-new").disabled = busy;
  if (tool) {
    button("cancel").disabled = busy;
    button("apply").disabled = busy || (tool === "extrude" && renderedLength !== input("length").value);
  }
}

async function work(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  controls();
  try {
    await fn();
  } catch (e) {
    status(message(e));
    appendOutput(message(e), true);
  } finally {
    busy = false;
    controls();
  }
}

function select(sketch?: string, body?: string, pick?: TopologyPick) {
  if (busy || tool) return;
  selectedSketch = sketch;
  selectedBody = body;
  const proxy = body && proxies.get(body);
  selectedTopology = proxy && pick ? { pick, revision: proxy.revision } : undefined;
  if (sketch || body) objectTab = sketch ? "Sketches" : "Bodies";
  drawLists();
  viewport.setSketches(rectangles, sketch);
  viewport.setBodies(proxies, body, pick);
  controls();
  status(
    pick
      ? "edge" in pick
        ? "Edge selected"
        : "Face selected"
      : sketch
        ? "Profile selected"
        : body
          ? "Body selected"
          : "Ready",
  );
}

function drawLists() {
  const ids =
    objectTab === "Bodies"
      ? Array.from(proxies.keys())
      : objectTab === "Sketches"
        ? entries.filter((e) => e.type === "sketch").map((e) => e.id)
        : [];
  el("object-list").replaceChildren();
  el("object-list").hidden = objectTab === "Construction";
  el("construction-list").hidden = objectTab !== "Construction";
  if (!ids.length && objectTab !== "Construction") {
    const note = document.createElement("p");
    note.className = "empty";
    note.textContent = "No " + objectTab.toLowerCase();
    el("object-list").append(note);
  }
  ids.forEach((id, index) => {
    const b = document.createElement("button");
    b.className = "object-row";
    b.textContent = (objectTab === "Bodies" ? "Body " : "Sketch ") + (index + 1);
    b.title = id;
    b.disabled = !!tool;
    b.setAttribute("aria-pressed", String(id === (selectedBody || selectedSketch)));
    b.onclick = () => (objectTab === "Bodies" ? select(undefined, id) : select(id));
    el("object-list").append(b);
  });
  for (const tab of el("browser-tabs").querySelectorAll<HTMLButtonElement>("[role=tab]")) {
    const selected = tab.id === objectTab.toLowerCase() + "-tab";
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  el("browser-content").setAttribute("aria-labelledby", objectTab.toLowerCase() + "-tab");
  const features = entries.map((entry) => {
    const li = document.createElement("li");
    li.title = entry.id;
    li.textContent = entry.type === "sketch" ? "Sketch" : "Extrude";
    return li;
  });
  el("features").replaceChildren(...features);
  updateSceneTree([
    ["Construction", Object.entries(scene.construction.builtin.planes).map(
      ([name, plane]) => name.toUpperCase() + " plane · " + plane.id,
    )],
    ["Bodies", [...proxies.keys()]],
    ["Sketches", entries.filter((e) => e.type === "sketch").map((e) => e.id)],
    ["Timeline", entries.map((e) => e.type + " · " + e.id)],
  ]);
}

async function refresh() {
  const [timeline, bodies] = await Promise.all([scene.timeline.list(), scene.bodies.revisions()]);
  const nextProxies = new Map<string, BodyProxy>();
  for (const { body, revision } of bodies) {
    const cached = proxies.get(body.id);
    nextProxies.set(
      body.id,
      cached?.revision === revision ? cached : await scene.getProxyFor(body, { revision }),
    );
  }
  const previousFeatures = new Set(entries.map((entry) => entry.id));
  const latestCreated = timeline.findLast((entry) => !previousFeatures.has(entry.id));
  if (latestCreated) objectTab = latestCreated.type === "sketch" ? "Sketches" : "Bodies";
  entries = timeline;
  proxies.clear();
  nextProxies.forEach((proxy, id) => proxies.set(id, proxy));
  if (selectedBody && !proxies.has(selectedBody)) selectedBody = undefined;
  if (!selectedBody || selectedTopology?.revision !== proxies.get(selectedBody)?.revision)
    selectedTopology = undefined;
  viewport.setBodies(proxies, selectedBody, selectedTopology?.pick);
  viewport.setSketches(rectangles, selectedSketch);
  drawLists();
}

function closeTool(discard = true) {
  if (discard && tool === "extrude") {
    void scene.discardPreview().catch((e) => appendOutput(message(e), true));
  }
  clearTimeout(timer);
  revision++;
  renderedLength = undefined;
  const wasSketching = tool === "sketch";
  tool = undefined;
  anchor = undefined;
  drawing = false;
  el("tool-panel").hidden = true;
  viewport.setDraft();
  viewport.setPreview();
  if (wasSketching) viewport.sketching(false);
  controls();
  drawLists();
}

async function newScene() {
  if (scene && (entries.length || tool) && !window.confirm("Discard the current scene and start a new one?"))
    return;
  await work(async () => {
    const created = await core.scene.create("Untitled");
    if (tool) closeTool();
    scene = created;
    rectangles.clear();
    regions.clear();
    proxies.clear();
    selectedBody = selectedSketch = undefined;
    objectTab = "Bodies";
    await refresh();
    viewport.home();
    status("Ready");
  });
}

function openPanel(name: "sketch" | "extrude") {
  const panel = el("tool-panel");
  const template = el<HTMLTemplateElement>(name + "-fields");
  panel.replaceChildren(template.content.cloneNode(true));
  panel.hidden = false;
  button("cancel").onclick = () => {
    closeTool();
    status("Ready");
  };
  controls();
  drawLists();
}
function rectangle(): Rectangle {
  const from: Point = anchor || [0, 0];
  const w = input("width").valueAsNumber,
    h = input("height").valueAsNumber;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w === 0 || h === 0)
    throw new Error("Enter a nonzero width and height.");
  return { from, to: [from[0] + w, from[1] + h] };
}
function updateDraft() {
  try {
    viewport.setDraft(rectangle());
    button("apply").disabled = false;
  } catch {
    viewport.setDraft();
    button("apply").disabled = true;
  }
}
function updateCorner(point: Point) {
  input("width").value = String(Number((point[0] - anchor![0]).toFixed(2)));
  input("height").value = String(Number((point[1] - anchor![1]).toFixed(2)));
  updateDraft();
}
function beginSketch() {
  tool = "sketch";
  anchor = undefined;
  drawing = false;
  openPanel("sketch");
  status("Sketching on XY");
  viewport.sketching(true);
  updateDraft();
  for (const id of ["width", "height"])
    input(id).oninput = () => {
      drawing = false;
      updateDraft();
    };
  button("apply").onclick = () =>
    work(async () => {
      const rect = rectangle();
      const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
      await sketch.primitives.add("rectangle", rect);
      await sketch.complete();
      const region = await sketch.regions.only();
      rectangles.set(sketch.id, rect);
      regions.set(sketch.id, region);
      selectedSketch = sketch.id;
      selectedBody = undefined;
      objectTab = "Sketches";
      closeTool();
      await refresh();
      viewport.home();
      status("Profile selected");
    });
}

async function preview() {
  if (pendingPreview || tool !== "extrude") return;
  clearTimeout(timer);
  const version = revision;
  const length = input("length").value;
  pendingPreview = true;
  controls();
  try {
    if (!length.trim()) {
      await scene.discardPreview();
      throw new Error("Enter an extrusion length.");
    }
    const result = await core.solid.extrude(
      regions.get(selectedSketch!)!,
      { length1: length },
      { preview: true },
    );
    if (revision === version) {
      const changed = [...result.newSolids, ...result.affectedSolids];
      const replacements = await Promise.all(
        changed.map((body) => scene.getProxyFor(body, { preview: true, revision: result.revision })),
      );
      if (revision !== version) return;
      viewport.setPreview(
        replacements,
        result.removedSolids.map((body) => body.id),
      );
      if (fitFirstPreview) {
        viewport.home();
        fitFirstPreview = false;
      }
      renderedLength = length;
      status("Extrusion preview");
    }
  } catch (e) {
    if (revision === version) {
      viewport.setPreview();
      input("length").setCustomValidity(message(e));
      status(message(e));
    }
  } finally {
    pendingPreview = false;
    controls();
    if (version !== revision && tool === "extrude") queueMicrotask(preview);
  }
}
function schedulePreview() {
  revision++;
  renderedLength = undefined;
  clearTimeout(timer);
  input("length").setCustomValidity("");
  status("Updating extrusion preview…");
  controls();
  timer = setTimeout(preview, 90);
}
async function beginExtrude() {
  if (!selectedSketch) return;
  const id = selectedSketch;
  if (!regions.has(id)) {
    await work(async () => {
      regions.set(id, await transport.request("sketch.regions.only", { sketch: { sceneId: scene.id, id } }));
    });
    if (!regions.has(id)) return;
  }
  tool = "extrude";
  fitFirstPreview = true;
  openPanel("extrude");
  input("length").oninput = schedulePreview;
  button("apply").onclick = () =>
    work(async () => {
      const feature = await core.solid.extrude(regions.get(selectedSketch!)!, {
        length1: input("length").value,
      });
      selectedBody = feature.newSolids[0]?.id;
      selectedTopology = undefined;
      selectedSketch = undefined;
      objectTab = "Bodies";
      closeTool(false);
      await refresh();
      viewport.home();
      status("Extrusion created");
    });
  schedulePreview();
}

async function runConsole(source: string) {
  await work(async () => {
    appendOutput("› " + source);
    const worker = new Worker(new URL("./runtime/console.worker.ts", import.meta.url), { type: "module" });
    const { id, name, construction, units } = scene;
    try {
      await new Promise<void>((resolve, reject) => {
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessage = async ({ data }) => {
          if ("id" in data) {
            try {
              worker.postMessage({ id: data.id, value: await transport.request(data.method, data.params) });
            } catch (e) {
              worker.postMessage({ id: data.id, error: message(e) });
            }
          } else {
            appendOutput(data.failure ?? data.output, !!data.failure);
            resolve();
          }
        };
        worker.postMessage({ source, scene: { id, name, construction, units } });
      });
    } finally {
      worker.terminate();
      await refresh();
    }
  });
}

async function start() {
  editorTheme.apply(document);
  document.querySelector<HTMLImageElement>(".wordmark")!.src = wordmarkUrl;
  document.querySelector<HTMLImageElement>("#extrude img")!.src = extrudeIconUrl;
  document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href = faviconUrl;
  el("runtime").textContent = desktop ? "Native" : "WebAssembly";
  el("web-menu").hidden = desktop;
  viewport = new Viewport(
    el("viewport"),
    (hit) => {
      if (busy) return;
      if (tool === "sketch" && hit.point) {
        if (drawing) {
          updateCorner(hit.point);
          drawing = false;
          status("Rectangle ready");
        } else {
          anchor = hit.point;
          drawing = true;
          viewport.setDraft();
          button("apply").disabled = true;
          status("Pick the opposite corner");
        }
      } else if (!tool) select(hit.sketch, hit.body, hit.pick);
    },
    (point) => {
      if (tool === "sketch" && drawing && point && !busy) updateCorner(point);
    },
    editorTheme.definition,
  );
  editorTheme.subscribe((theme) => viewport.setTheme(theme));
  button("new-sketch").onclick = beginSketch;
  button("extrude").onclick = beginExtrude;
  button("home").onclick = () => viewport.home();
  const cameraButton = button("camera-mode");
  const cameraModes = el("camera-modes");
  const setCameraMenuOpen = (open: boolean) => {
    cameraModes.hidden = !open;
    cameraButton.setAttribute("aria-expanded", String(open));
    if (open) cameraModes.querySelector<HTMLInputElement>("input:checked")!.focus();
  };
  cameraButton.onclick = () => setCameraMenuOpen(cameraModes.hidden);
  cameraModes.onclick = (event) => {
    const choice = event.target;
    if (!(choice instanceof HTMLInputElement)) return;
    if (choice.value !== "orthographic" && choice.value !== "perspective") return;
    viewport.setCameraMode(choice.value);
    setCameraMenuOpen(false);
    cameraButton.focus();
  };
  const closeCameraMenuOutside = (event: Event) => {
    if (cameraModes.hidden || !(event.target instanceof Node)) return;
    if (!cameraButton.contains(event.target) && !cameraModes.contains(event.target)) setCameraMenuOpen(false);
  };
  document.addEventListener("pointerdown", closeCameraMenuOutside);
  document.addEventListener("focusin", closeCameraMenuOutside);
  for (const name of ["Components", "Construction", "Bodies", "Sketches"] as const) {
    button(name.toLowerCase() + "-tab").onclick = () => {
      objectTab = name;
      drawLists();
    };
  }
  initSceneBrowser();
  await initOutputDock(runConsole, status);
  const menu = (id: string) => {
    document.querySelectorAll<HTMLDetailsElement>("nav details").forEach((node) => (node.open = false));
    if (id === "new" && !busy) void newScene();
    if (id === "help") el<HTMLDialogElement>("help").showModal();
  };
  button("menu-new").onclick = () => menu("new");
  button("menu-help").onclick = () => menu("help");
  if (desktop) {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<string>("editor-menu", (e) => menu(e.payload));
  }
  document.addEventListener("keydown", (e) => {
    if (!cameraModes.hidden) {
      if (e.key === "Escape") {
        setCameraMenuOpen(false);
        cameraButton.focus();
      } else if (e.key === "Enter" && e.target instanceof HTMLInputElement && cameraModes.contains(e.target)) {
        e.preventDefault();
        e.target.click();
      }
      return;
    }
    if (e.key === "Escape" && tool && !busy) {
      closeTool();
      status("Ready");
    }
    if (e.key === "Enter" && tool && e.target instanceof HTMLInputElement) button("apply").click();
  });
  await newScene();
}
start().catch((e) => {
  status(message(e));
  appendOutput(message(e), true);
});
