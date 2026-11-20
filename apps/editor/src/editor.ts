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
let viewport: Viewport;
let busy = false;
let revision = 0;
let timer: ReturnType<typeof setTimeout>;
let pendingPreview = false;
let stopConsole: (() => void) | undefined;

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
  const doc = activeDocument;
  button("new-sketch").disabled = busy || !doc || !!doc.tool;
  button("extrude").disabled = busy || !doc?.selectedSketch || !!doc.tool;
  for (const [id, name] of [
    ["new-sketch", "sketch"],
    ["extrude", "extrude"],
  ]) {
    button(id).setAttribute("aria-pressed", String(doc?.tool === name));
  }
  el("progress").hidden = !busy && !pendingPreview;
  setConsoleEnabled(!busy && !!doc && !doc.tool && !pendingPreview, stopConsole);
  menu?.setBusy(busy || pendingPreview);
  documentTabs?.render([...documents.values()].map(({ scene }) => ({ id: scene.id, name: scene.name ?? "Untitled" })), activeDocument?.scene.id, busy || pendingPreview);
  if (doc?.tool) {
    button("cancel").disabled = busy;
    let valid = true;
    if (doc.tool === "sketch") {
      try { rectangle(); } catch { valid = false; }
    }
    button("apply").disabled = busy || (doc.tool === "sketch" ? doc.drawing || !valid : doc.renderedLength !== input("length").value);
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
  const doc = activeDocument;
  if (!doc || busy || doc.tool) return;
  doc.selectedPlane = plane;
  doc.selectedSketch = sketch;
  doc.selectedBody = body;
  const proxy = body && doc.proxies.get(body);
  doc.selectedTopology = proxy && pick ? { pick, revision: proxy.revision } : undefined;
  if (plane) doc.objectTab = "Construction";
  if (sketch || body) doc.objectTab = sketch ? "Sketches" : "Bodies";
  drawLists();
  viewport.setSketches(doc.rectangles, sketch);
  viewport.setBodies(doc.proxies, body, pick);
  viewport.setConstruction(Object.values(doc.scene.construction.builtin.planes), plane);
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
  const doc = activeDocument;
  if (!doc) return [];
  const leaf = (id: string, label: string, kind: "body" | "sketch" | "plane"): TreeNode => ({
    id, label, kind, visible: !doc.hiddenObjects.has(id),
    selected: id === doc.selectedBody || id === doc.selectedSketch || id === doc.selectedPlane,
  });
  let children: TreeNode[] = [];
  if (doc.objectTab === "Bodies") children = [...doc.proxies.keys()].map((id, i) => leaf(id, "Body " + (i + 1), "body"));
  if (doc.objectTab === "Sketches") children = doc.entries.filter((e) => e.type === "sketch").map((entry, i) => leaf(entry.id, "Sketch " + (i + 1), "sketch"));
  if (doc.objectTab === "Construction") {
    const planes = Object.entries(doc.scene.construction.builtin.planes).map(([name, plane]) => leaf(plane.id, name.toUpperCase() + " plane", "plane"));
    children = [{ id: "origin", stateKey: "origin", label: "Origin", kind: "group", children: planes,
      visible: planes.some((plane) => plane.visible) }];
  }
  return [{ id: "scene-root", stateKey: doc.objectTab + "/root", label: doc.scene.name ?? "Untitled", kind: "scene", children,
    visible: children.some((child) => child.visible) }];
}

function drawLists() {
  const doc = activeDocument;
  browser?.render(doc?.objectTab ?? browser.activeTab, treeNodes(), busy || !!doc?.tool, doc?.scene.id);
  if (!doc) {
    el("features").replaceChildren();
    updateSceneTree([]);
    return;
  }
  const features = doc.entries.map((entry) => {
    const li = document.createElement("li");
    li.title = entry.id;
    li.textContent = entry.type === "sketch" ? "Sketch" : "Extrude";
    return li;
  });
  el("features").replaceChildren(...features);
  updateSceneTree([
    ["Construction", Object.entries(doc.scene.construction.builtin.planes).map(
      ([name, plane]) => name.toUpperCase() + " plane · " + plane.id,
    )],
    ["Bodies", [...doc.proxies.keys()]],
    ["Sketches", doc.entries.filter((e) => e.type === "sketch").map((e) => e.id)],
    ["Timeline", doc.entries.map((e) => e.type + " · " + e.id)],
  ]);
}

async function refresh() {
  const doc = activeDocument;
  if (!doc) return;
  const [timeline, bodies] = await Promise.all([doc.scene.timeline.list(), doc.scene.bodies.revisions()]);
  const nextProxies = new Map<string, BodyProxy>();
  for (const { body, revision } of bodies) {
    const cached = doc.proxies.get(body.id);
    nextProxies.set(
      body.id,
      cached?.revision === revision ? cached : await doc.scene.getProxyFor(body, { revision }),
    );
  }
  const previousFeatures = new Set(doc.entries.map((entry) => entry.id));
  const latestCreated = timeline.findLast((entry) => !previousFeatures.has(entry.id));
  if (latestCreated) doc.objectTab = latestCreated.type === "sketch" ? "Sketches" : "Bodies";
  doc.entries = timeline;
  doc.proxies.clear();
  nextProxies.forEach((proxy, id) => doc.proxies.set(id, proxy));
  if (doc.selectedBody && !doc.proxies.has(doc.selectedBody)) doc.selectedBody = undefined;
  if (!doc.selectedBody || doc.selectedTopology?.revision !== doc.proxies.get(doc.selectedBody)?.revision)
    doc.selectedTopology = undefined;
  viewport.setBodies(doc.proxies, doc.selectedBody, doc.selectedTopology?.pick);
  viewport.setSketches(doc.rectangles, doc.selectedSketch);
  drawLists();
}

function closeTool(discard = true) {
  const doc = activeDocument;
  if (!doc) return;
  if (discard && doc.tool === "extrude") {
    void doc.scene.discardPreview().catch((e) => appendOutput(message(e), true));
  }
  clearTimeout(timer);
  revision++;
  doc.renderedLength = undefined;
  const wasSketching = doc.tool === "sketch";
  doc.tool = undefined;
  doc.anchor = undefined;
  doc.drawing = false;
  el("tool-panel").hidden = true;
  setDraft();
  setPreview();
  if (wasSketching) viewport.sketching(false);
  controls();
  drawLists();
}

function setPreview(bodies: BodyProxy[] = [], removed: string[] = []) {
  if (activeDocument) {
    activeDocument.previewBodies = bodies;
    activeDocument.previewRemoved = removed;
  }
  viewport.setPreview(bodies, removed);
}

function setDraft(rectangle?: Rectangle) {
  if (activeDocument) activeDocument.draft = rectangle;
  viewport.setDraft(rectangle);
}

function saveDocument() {
  if (!activeDocument) return;
  activeDocument.panel = [...el("tool-panel").childNodes];
  activeDocument.view = viewport.captureView();
  activeDocument.output = captureOutput();
  clearTimeout(timer);
  revision++;
}

function showDocument(doc?: EditorDocument) {
  activeDocument = doc;
  el("tool-panel").replaceChildren(...doc?.panel ?? []);
  el("tool-panel").hidden = !doc?.tool;
  restoreOutput(doc?.output);
  viewport.setDraft(doc?.draft);
  viewport.setPreview();
  viewport.setVisibility(doc?.hiddenObjects ?? new Set());
  viewport.setBodies(doc?.proxies ?? new Map(), doc?.selectedBody, doc?.selectedTopology?.pick);
  viewport.setSketches(doc?.rectangles ?? new Map(), doc?.selectedSketch);
  viewport.setConstruction(doc ? Object.values(doc.scene.construction.builtin.planes) : [], doc?.selectedPlane);
  viewport.sketching(doc?.tool === "sketch");
  viewport.setPreview(doc?.previewBodies, doc?.previewRemoved);
  if (doc?.view) viewport.restoreView(doc.view);
  else viewport.home();
  const mode = doc?.view?.mode ?? "orthographic";
  const radio = document.querySelector<HTMLInputElement>(`input[name="projection"][value="${mode}"]`)!;
  radio.checked = true;
  if (!doc?.view) viewport.setCameraMode(mode);
  el("camera-modes").hidden = true;
  button("camera-mode").setAttribute("aria-expanded", "false");
  document.title = doc ? `PamatCAD · ${doc.scene.name}` : "PamatCAD";
  status(doc?.status ?? "No open documents");
  if (!doc) browser.render(browser.initialTab, [], busy);
  drawLists();
  controls();
  if (doc?.tool === "extrude" && doc.renderedLength !== input("length").value) schedulePreview();
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
  const doc = activeDocument;
  if (doc?.tool === "extrude" && doc.renderedLength !== input("length").value && !pendingPreview) schedulePreview();
}

async function closeDocument(id: string) {
  if (busy || pendingPreview) return;
  const doc = documents.get(id);
  if (!doc) return;
  const hasContent = doc.entries.length || doc.tool;
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
  const doc = activeDocument;
  if (!doc || busy || doc.tool) return;
  const visit = (node: TreeNode, inherited = false) => {
    const change = inherited || node.id === id;
    if (node.children) node.children.forEach((child) => visit(child, change));
    else if (change) {
      if (visible) doc.hiddenObjects.delete(node.id); else doc.hiddenObjects.add(node.id);
      if (!visible && node.id === doc.selectedSketch) doc.selectedSketch = undefined;
      if (!visible && node.id === doc.selectedBody) { doc.selectedBody = undefined; doc.selectedTopology = undefined; }
      if (!visible && node.id === doc.selectedPlane) doc.selectedPlane = undefined;
    }
  };
  treeNodes().forEach((node) => visit(node));
  viewport.setVisibility(doc.hiddenObjects);
  viewport.setBodies(doc.proxies, doc.selectedBody, doc.selectedTopology?.pick);
  viewport.setSketches(doc.rectangles, doc.selectedSketch);
  viewport.setConstruction(Object.values(doc.scene.construction.builtin.planes), doc.selectedPlane);
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
  const from: Point = activeDocument?.anchor || [0, 0];
  const w = input("width").valueAsNumber,
    h = input("height").valueAsNumber;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w === 0 || h === 0)
    throw new Error("Enter a nonzero width and height.");
  return { from, to: [from[0] + w, from[1] + h] };
}
function updateDraft() {
  const doc = activeDocument;
  if (!doc) return;
  try {
    setDraft(rectangle());
    button("apply").disabled = busy || doc.drawing;
  } catch {
    setDraft();
    button("apply").disabled = true;
  }
}
function updateCorner(point: Point) {
  const anchor = activeDocument?.anchor;
  if (!anchor) return;
  input("width").value = String(Number((point[0] - anchor[0]).toFixed(2)));
  input("height").value = String(Number((point[1] - anchor[1]).toFixed(2)));
  updateDraft();
}
function beginSketch() {
  const doc = activeDocument;
  if (!doc) return;
  doc.tool = "sketch";
  doc.anchor = undefined;
  doc.drawing = false;
  openPanel("sketch");
  status("Sketching on XY");
  viewport.sketching(true);
  updateDraft();
  for (const id of ["width", "height"])
    input(id).oninput = () => {
      doc.drawing = false;
      updateDraft();
    };
  button("apply").onclick = () =>
    work(async () => {
      const rect = rectangle();
      const sketch = await doc.scene.sketches.create(doc.scene.construction.builtin.planes.xy);
      await sketch.primitives.add("rectangle", rect);
      await sketch.complete();
      const region = await sketch.regions.only();
      doc.rectangles.set(sketch.id, rect);
      doc.regions.set(sketch.id, region);
      doc.selectedSketch = sketch.id;
      doc.selectedBody = undefined;
      doc.objectTab = "Sketches";
      closeTool();
      await refresh();
      viewport.home();
      status("Profile selected");
    });
}

async function preview() {
  const doc = activeDocument;
  if (!doc || pendingPreview || doc.tool !== "extrude") return;
  clearTimeout(timer);
  const version = revision;
  const length = input("length").value;
  pendingPreview = true;
  controls();
  try {
    if (!length.trim()) {
      await doc.scene.discardPreview();
      throw new Error("Enter an extrusion length.");
    }
    const result = await core.solid.extrude(
      doc.regions.get(doc.selectedSketch!)!,
      { length1: length },
      { preview: true },
    );
    if (revision === version) {
      const changed = [...result.newSolids, ...result.affectedSolids];
      const replacements = await Promise.all(
        changed.map((body) => doc.scene.getProxyFor(body, { preview: true, revision: result.revision })),
      );
      if (revision !== version) return;
      setPreview(
        replacements,
        result.removedSolids.map((body) => body.id),
      );
      if (doc.fitFirstPreview) {
        viewport.home();
        doc.fitFirstPreview = false;
      }
      doc.renderedLength = length;
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
    if (version !== revision && doc.tool === "extrude") queueMicrotask(preview);
  }
}
function schedulePreview() {
  const doc = activeDocument;
  if (!doc || doc.tool !== "extrude") return;
  revision++;
  doc.renderedLength = undefined;
  clearTimeout(timer);
  input("length").setCustomValidity("");
  status("Updating extrusion preview…");
  controls();
  timer = setTimeout(preview, 90);
}
async function beginExtrude() {
  const doc = activeDocument;
  if (!doc?.selectedSketch) return;
  const id = doc.selectedSketch;
  if (!doc.regions.has(id)) {
    await work(async () => {
      doc.regions.set(id, await transport.request("sketch.regions.only", { sketch: { sceneId: doc.scene.id, id } }));
    });
    if (!doc.regions.has(id)) return;
  }
  doc.tool = "extrude";
  doc.fitFirstPreview = true;
  openPanel("extrude");
  input("length").oninput = schedulePreview;
  button("apply").onclick = () =>
    work(async () => {
      const feature = await core.solid.extrude(doc.regions.get(doc.selectedSketch!)!, {
        length1: input("length").value,
      });
      doc.selectedBody = feature.newSolids[0]?.id;
      doc.selectedTopology = undefined;
      doc.selectedSketch = undefined;
      doc.objectTab = "Bodies";
      closeTool(false);
      await refresh();
      viewport.home();
      status("Extrusion created");
    });
  schedulePreview();
}

async function runConsole(source: string) {
  const doc = activeDocument;
  if (!doc) return;
  await work(async () => {
    appendOutput("› " + source);
    const worker = new Worker(new URL("./runtime/console.worker.ts", import.meta.url), { type: "module" });
    const { id, name, construction, units } = doc.scene;
    const pending = new Set<Promise<unknown>>();
    let finished = false;
    let stopped = false;
    try {
      await new Promise<void>((resolve, reject) => {
        stopConsole = () => {
          stopped = finished = true;
          worker.terminate();
          status("Stopping script…");
          resolve();
        };
        controls();
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessage = ({ data }) => {
          if (finished) return;
          if ("id" in data) {
            const job = transport.request(data.method, data.params);
            pending.add(job);
            void job.then(
              (value) => { if (!finished) worker.postMessage({ id: data.id, value }); },
              (e) => {
                if (!finished) worker.postMessage({ id: data.id, error: message(e) });
                else appendOutput(message(e), true);
              },
            ).catch(reject).finally(() => pending.delete(job));
          } else {
            appendOutput(data.failure ?? data.output, !!data.failure);
            resolve();
          }
        };
        worker.postMessage({ source, scene: { id, name, construction, units } });
      });
    } finally {
      finished = true;
      stopConsole = undefined;
      worker.terminate();
      controls();
      // Stopping JavaScript cannot cancel requests already sent to the geometry engine.
      await Promise.allSettled(pending);
      await refresh();
      if (stopped) {
        appendOutput("Script stopped");
        status("Script stopped");
      }
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
      const doc = activeDocument;
      if (!doc || busy) return;
      if (doc.tool === "sketch" && hit.point) {
        if (doc.drawing) {
          updateCorner(hit.point);
          doc.drawing = false;
          controls();
          status("Rectangle ready");
        } else {
          doc.anchor = hit.point;
          doc.drawing = true;
          setDraft();
          button("apply").disabled = true;
          status("Pick the opposite corner");
        }
      } else if (!doc.tool) select(hit.sketch, hit.body, hit.pick, hit.plane);
    },
    (point) => {
      const doc = activeDocument;
      if (doc?.tool === "sketch" && doc.drawing && point && !busy) updateCorner(point);
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
    onTab(tab) {
      if (activeDocument) activeDocument.objectTab = tab;
      browser.render(tab, treeNodes(), busy || !!activeDocument?.tool, activeDocument?.scene.id);
    },
    onSelect(id) {
      const doc = activeDocument;
      if (!doc) return;
      if (doc.proxies.has(id)) select(undefined, id);
      else if (doc.entries.some((entry) => entry.type === "sketch" && entry.id === id)) select(id);
      else if (Object.values(doc.scene.construction.builtin.planes).some((plane) => plane.id === id)) select(undefined, undefined, undefined, id);
    },
    onVisibility: changeVisibility,
  });
  documentTabs = initDocumentTabs({ activate: activateDocument, close: (id) => { void closeDocument(id); }, create: () => { void newScene(); }, reorder: reorderDocument });
  await initOutputDock(runConsole, status);
  menu = initMenu({ newScene: () => { void newScene(); }, resetUi: () => {
    resetUiSettings();
    for (const doc of documents.values()) doc.objectTab = "Bodies";
    viewport.setCameraMode("orthographic");
    document.querySelector<HTMLInputElement>('input[name="projection"][value="orthographic"]')!.checked = true;
    drawLists();
  } });
  document.addEventListener("keydown", (e) => {
    const doc = activeDocument;
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
    if (e.key === "Escape" && doc?.tool && !busy) {
      closeTool();
      status("Ready");
    }
    if (e.key === "Enter" && doc?.tool && e.target instanceof HTMLInputElement) button("apply").click();
  });
  await newScene();
  if (!activeDocument) throw new Error(el("status").textContent || "Could not create the initial scene");
}
