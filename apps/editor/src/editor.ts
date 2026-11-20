import "./style.css";
import wordmarkUrl from "../../../doc/media/logo-letters.svg?url";
import faviconUrl from "../../../doc/media/logo.svg?url";
import extrudeIconUrl from "../../../doc/api/command/solid/extrude/icon.svg?url";
import { Core, type Scene, type RegionRef, type BodyProxy, type TimelineEntry } from "@pamatcad/sdk";
import { editorTransport } from "./runtime/transport";
import { appendOutput, initOutputDock, logCommand, setConsoleEnabled, updateSceneTree, captureOutput, restoreOutput, type OutputState } from "./dock";
import { Viewport, type Point, type Rectangle, type TopologyPick, type ViewState } from "./viewport";
import { initSceneBrowser, type BrowserTab, type TreeNode } from "./scene-browser";
import { editorTheme } from "./theme";
import { initStatusLine } from "./status-line";
import { initMenu } from "./menu";
import { initDocumentTabs } from "./documents";
import { resetUiSettings } from "./ui-settings";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => el<HTMLButtonElement>(id);
const input = (id: string) => el<HTMLInputElement>(id);
const message = (value: unknown) => (value instanceof Error ? value.message : String(value));
const desktop = import.meta.env.MODE === "desktop";
let scene: Scene;
let viewport: Viewport;
let entries: TimelineEntry[] = [];
let rectangles = new Map<string, Rectangle>();
let regions = new Map<string, RegionRef>();
let proxies = new Map<string, BodyProxy>();
let selectedSketch: string | undefined;
let selectedBody: string | undefined;
let selectedTopology: { pick: TopologyPick; revision: string } | undefined;
let objectTab: BrowserTab = "Bodies";
let selectedPlane: string | undefined;
let hiddenObjects = new Set<string>();
let previewBodies: BodyProxy[] = [];
let previewRemoved: string[] = [];
let tool: "sketch" | "extrude" | undefined;
let busy = false;
let anchor: Point | undefined;
let drawing = false;
let draftRectangle: Rectangle | undefined;
let revision = 0;
let timer: ReturnType<typeof setTimeout>;
let pendingPreview = false;
let renderedLength: string | undefined;
let fitFirstPreview = false;
type EditorDocument = {
  scene: Scene;
  entries: TimelineEntry[];
  rectangles: Map<string, Rectangle>;
  regions: Map<string, RegionRef>;
  proxies: Map<string, BodyProxy>;
  selectedSketch?: string;
  selectedBody?: string;
  selectedPlane?: string;
  selectedTopology?: { pick: TopologyPick; revision: string };
  objectTab: BrowserTab;
  hiddenObjects: Set<string>;
  tool?: "sketch" | "extrude";
  anchor?: Point;
  drawing: boolean;
  draft?: Rectangle;
  renderedLength?: string;
  fitFirstPreview: boolean;
  previewBodies: BodyProxy[];
  previewRemoved: string[];
  panel: Node[];
  view?: ViewState;
  output?: OutputState;
  status: string;
};
const documents = new Map<string, EditorDocument>();
let activeDocument: EditorDocument | undefined;
let nextDocument = 0;
let documentTabs: ReturnType<typeof initDocumentTabs>;
let browser: ReturnType<typeof initSceneBrowser>;
let menu: ReturnType<typeof initMenu>;
const status = (text: string) => {
  el("status").textContent = text;
  if (activeDocument) activeDocument.status = text;
};

const transport = editorTransport(logCommand);
const core = new Core(transport);

function controls() {
  button("new-sketch").disabled = busy || !activeDocument || !!tool;
  button("extrude").disabled = busy || !selectedSketch || !!tool;
  for (const [id, name] of [
    ["new-sketch", "sketch"],
    ["extrude", "extrude"],
  ]) {
    button(id).setAttribute("aria-pressed", String(tool === name));
  }
  el("progress").hidden = !busy && !pendingPreview;
  setConsoleEnabled(!busy && !!activeDocument && !tool && !pendingPreview);
  menu?.setBusy(busy || pendingPreview);
  documentTabs?.render([...documents.values()].map(({ scene }) => ({ id: scene.id, name: scene.name ?? "Untitled" })), activeDocument?.scene.id, busy || pendingPreview);
  if (tool) {
    button("cancel").disabled = busy;
    let valid = true;
    if (tool === "sketch") {
      try { rectangle(); } catch { valid = false; }
    }
    button("apply").disabled = busy || (tool === "sketch" ? drawing || !valid : renderedLength !== input("length").value);
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
    drawLists();
    controls();
  }
}

function select(sketch?: string, body?: string, pick?: TopologyPick, plane?: string) {
  if (busy || tool || !activeDocument) return;
  selectedPlane = plane;
  selectedSketch = sketch;
  selectedBody = body;
  const proxy = body && proxies.get(body);
  selectedTopology = proxy && pick ? { pick, revision: proxy.revision } : undefined;
  if (plane) objectTab = "Construction";
  if (sketch || body) objectTab = sketch ? "Sketches" : "Bodies";
  drawLists();
  viewport.setSketches(rectangles, sketch);
  viewport.setBodies(proxies, body, pick);
  viewport.setConstruction(Object.values(scene.construction.builtin.planes), plane);
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
          : plane ? "Plane selected" : "Ready",
  );
}

function treeNodes(): TreeNode[] {
  if (!activeDocument) return [];
  const leaf = (id: string, label: string, kind: "body" | "sketch" | "plane"): TreeNode => ({
    id, label, kind, visible: !hiddenObjects.has(id),
    selected: id === selectedBody || id === selectedSketch || id === selectedPlane,
  });
  let children: TreeNode[] = [];
  if (objectTab === "Bodies") children = [...proxies.keys()].map((id, i) => leaf(id, "Body " + (i + 1), "body"));
  if (objectTab === "Sketches") children = entries.filter((e) => e.type === "sketch").map((entry, i) => leaf(entry.id, "Sketch " + (i + 1), "sketch"));
  if (objectTab === "Construction") {
    const planes = Object.entries(scene.construction.builtin.planes).map(([name, plane]) => leaf(plane.id, name.toUpperCase() + " plane", "plane"));
    children = [{ id: "origin", stateKey: "origin", label: "Origin", kind: "group", children: planes,
      visible: planes.some((plane) => plane.visible) }];
  }
  return [{ id: "scene-root", stateKey: objectTab + "/root", label: scene.name ?? "Untitled", kind: "scene", children,
    visible: children.some((child) => child.visible) }];
}

function drawLists() {
  browser?.render(objectTab, treeNodes(), busy || !!tool, activeDocument?.scene.id);
  if (!activeDocument) {
    el("features").replaceChildren();
    updateSceneTree([]);
    return;
  }
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
  setDraft();
  setPreview();
  if (wasSketching) viewport.sketching(false);
  controls();
  drawLists();
}

function setPreview(bodies: BodyProxy[] = [], removed: string[] = []) {
  previewBodies = bodies;
  previewRemoved = removed;
  viewport.setPreview(bodies, removed);
}

function setDraft(rectangle?: Rectangle) {
  draftRectangle = rectangle;
  viewport.setDraft(rectangle);
}

function saveDocument() {
  if (!activeDocument) return;
  Object.assign(activeDocument, { entries, rectangles, regions, proxies, selectedSketch, selectedBody,
    selectedPlane, selectedTopology, objectTab, hiddenObjects, tool, anchor, drawing, renderedLength,
    fitFirstPreview, previewBodies, previewRemoved, draft: draftRectangle, panel: [...el("tool-panel").childNodes],
    view: viewport.captureView(), output: captureOutput(), status: el("status").textContent ?? "Ready" });
  clearTimeout(timer);
  revision++;
}

function showDocument(doc?: EditorDocument) {
  activeDocument = doc;
  entries = doc?.entries ?? [];
  rectangles = doc?.rectangles ?? new Map();
  regions = doc?.regions ?? new Map();
  proxies = doc?.proxies ?? new Map();
  selectedSketch = doc?.selectedSketch;
  selectedBody = doc?.selectedBody;
  selectedPlane = doc?.selectedPlane;
  selectedTopology = doc?.selectedTopology;
  objectTab = doc?.objectTab ?? browser.initialTab;
  hiddenObjects = doc?.hiddenObjects ?? new Set();
  tool = doc?.tool;
  anchor = doc?.anchor;
  drawing = doc?.drawing ?? false;
  renderedLength = doc?.renderedLength;
  fitFirstPreview = doc?.fitFirstPreview ?? false;
  if (doc) scene = doc.scene;
  el("tool-panel").replaceChildren(...doc?.panel ?? []);
  el("tool-panel").hidden = !tool;
  restoreOutput(doc?.output);
  setDraft(doc?.draft);
  setPreview();
  viewport.setVisibility(hiddenObjects);
  viewport.setBodies(proxies, selectedBody, selectedTopology?.pick);
  viewport.setSketches(rectangles, selectedSketch);
  viewport.setConstruction(doc ? Object.values(scene.construction.builtin.planes) : [], selectedPlane);
  viewport.sketching(tool === "sketch");
  setPreview(doc?.previewBodies, doc?.previewRemoved);
  if (doc?.view) viewport.restoreView(doc.view);
  else viewport.home();
  const mode = doc?.view?.mode ?? "orthographic";
  const radio = document.querySelector<HTMLInputElement>(`input[name="projection"][value="${mode}"]`)!;
  radio.checked = true;
  if (!doc?.view) viewport.setCameraMode(mode);
  el("camera-modes").hidden = true;
  button("camera-mode").setAttribute("aria-expanded", "false");
  document.title = doc ? `PamatCAD · ${scene.name}` : "PamatCAD";
  status(doc?.status ?? "No open documents");
  drawLists();
  controls();
  if (tool === "extrude" && renderedLength !== input("length").value) schedulePreview();
}

function activateDocument(id: string) {
  if (busy || pendingPreview || activeDocument?.scene.id === id) return;
  const doc = documents.get(id);
  if (!doc) return;
  saveDocument();
  showDocument(doc);
}

function reorderDocument(id: string, beforeId: string | null) {
  if (busy || pendingPreview || id === beforeId) return;
  const moved = documents.get(id);
  if (!moved || (beforeId !== null && !documents.has(beforeId))) return;
  const ordered = [...documents.entries()].filter(([key]) => key !== id);
  const index = beforeId === null ? ordered.length : ordered.findIndex(([key]) => key === beforeId);
  ordered.splice(index, 0, [id, moved]);
  documents.clear();
  for (const [key, doc] of ordered) documents.set(key, doc);
  controls();
}

async function newScene() {
  if (pendingPreview) return;
  clearTimeout(timer);
  revision++;
  await work(async () => {
    const created = await core.scene.create("Untitled " + (++nextDocument));
    saveDocument();
    const doc: EditorDocument = { scene: created, entries: [], rectangles: new Map(), regions: new Map(),
      proxies: new Map(), objectTab: browser.initialTab,
      hiddenObjects: new Set(Object.values(created.construction.builtin.planes).map((plane) => plane.id)),
      drawing: false, fitFirstPreview: false, previewBodies: [], previewRemoved: [], panel: [], status: "Ready" };
    documents.set(created.id, doc);
    showDocument(doc);
  });
  if (tool === "extrude" && renderedLength !== input("length").value && !pendingPreview) schedulePreview();
}

async function closeDocument(id: string) {
  if (busy || pendingPreview) return;
  const doc = documents.get(id);
  if (!doc) return;
  const hasContent = doc === activeDocument ? entries.length || tool : doc.entries.length || doc.tool;
  if (hasContent && !window.confirm(`Close "${doc.scene.name}" and discard its contents?`)) return;
  if (doc === activeDocument) saveDocument();
  await work(async () => {
    await doc.scene.close();
    const ids = [...documents.keys()];
    const index = ids.indexOf(id);
    documents.delete(id);
    if (activeDocument === doc) {
      clearTimeout(timer);
      revision++;
      const next = ids[index + 1] ?? ids[index - 1];
      showDocument(next ? documents.get(next) : undefined);
    }
  });
}

function changeVisibility(id: string, visible: boolean) {
  if (!activeDocument || busy || tool) return;
  const visit = (node: TreeNode, inherited = false) => {
    const change = inherited || node.id === id;
    if (node.children) node.children.forEach((child) => visit(child, change));
    else if (change) {
      if (visible) hiddenObjects.delete(node.id); else hiddenObjects.add(node.id);
      if (!visible && node.id === selectedSketch) selectedSketch = undefined;
      if (!visible && node.id === selectedBody) { selectedBody = undefined; selectedTopology = undefined; }
      if (!visible && node.id === selectedPlane) selectedPlane = undefined;
    }
  };
  treeNodes().forEach((node) => visit(node));
  viewport.setVisibility(hiddenObjects);
  viewport.setBodies(proxies, selectedBody, selectedTopology?.pick);
  viewport.setSketches(rectangles, selectedSketch);
  viewport.setConstruction(Object.values(scene.construction.builtin.planes), selectedPlane);
  drawLists();
  controls();
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
    setDraft(rectangle());
    button("apply").disabled = busy || drawing;
  } catch {
    setDraft();
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
      setPreview(
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
      setPreview();
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

export async function startEditor() {
  editorTheme.apply(document);
  initStatusLine();
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
          controls();
          status("Rectangle ready");
        } else {
          anchor = hit.point;
          drawing = true;
          setDraft();
          button("apply").disabled = true;
          status("Pick the opposite corner");
        }
      } else if (!tool) select(hit.sketch, hit.body, hit.pick, hit.plane);
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
  browser = initSceneBrowser({
    onTab(tab) { objectTab = tab; drawLists(); },
    onSelect(id) {
      if (proxies.has(id)) select(undefined, id);
      else if (entries.some((entry) => entry.type === "sketch" && entry.id === id)) select(id);
      else if (activeDocument && Object.values(scene.construction.builtin.planes).some((plane) => plane.id === id)) select(undefined, undefined, undefined, id);
    },
    onVisibility: changeVisibility,
  });
  documentTabs = initDocumentTabs({ activate: activateDocument, close: (id) => { void closeDocument(id); }, create: () => { void newScene(); }, reorder: reorderDocument });
  await initOutputDock(runConsole, status);
  menu = initMenu({ newScene: () => { void newScene(); }, resetUi: () => {
    resetUiSettings();
    for (const doc of documents.values()) doc.objectTab = "Bodies";
    objectTab = "Bodies";
    viewport.setCameraMode("orthographic");
    document.querySelector<HTMLInputElement>('input[name="projection"][value="orthographic"]')!.checked = true;
    drawLists();
  } });
  document.addEventListener("keydown", (e) => {
    if (e.target instanceof Element && e.target.closest("dialog")) return;
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
  if (!activeDocument) throw new Error(el("status").textContent || "Could not create the initial scene");
}
