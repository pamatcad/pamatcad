import "./style.css";
import wordmarkUrl from "../../../doc/media/logo-letters.svg?url";
import faviconUrl from "../../../doc/media/logo.svg?url";
import extrudeIcon from "../../../doc/api/command/solid/extrude/icon.svg?raw";
import sketchIcon from "./icons/sketch.svg?raw";
import { Core, type Scene, type BodyProxy, type SketchProxy, type TimelineEntry, type SketchSupport } from "@pamatcad/sdk";
import { editorTransport } from "./runtime/transport";
import { appendOutput, initOutputDock, logCommand, setConsoleEnabled, updateSceneTree, captureOutput, restoreOutput, type OutputState } from "./dock";
import { Viewport, type Point, type Rectangle, type ViewState } from "./viewport";
import { initSceneBrowser, type BrowserTab, type TreeNode } from "./scene-browser";
import { editorTheme } from "./theme";
import { initStatusLine } from "./status-line";
import { initMenu } from "./menu";
import { captureScreenshot, saveScreenshot } from "./screenshot";
import { initDocumentTabs } from "./documents";
import { resetUiSettings } from "./ui-settings";
import { selectionOwner, changeSelection, type SelectionItem } from "./selection";
import { SketchTool } from "./tools/sketch";
import { ExtrudeTool } from "./tools/extrude";
import { initToolWindow, type ToolWindowState } from "./tool-window";
import { initRibbon, type Workbench } from "./ribbon";
import { initTooltips } from "./tooltips";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => el<HTMLButtonElement>(id);
const input = (id: string) => el<HTMLInputElement>(id);
const message = (value: unknown) => (value instanceof Error ? value.message : String(value));
const desktop = import.meta.env.MODE === "desktop";
let viewport: Viewport;
let busy = false;
let pendingPreview = false;
let stopConsole: (() => void) | undefined;

type EditorDocument = {
  workbench: Workbench;
  scene: Scene;
  entries: TimelineEntry[];
  sketches: Map<string, SketchProxy>;
  proxies: Map<string, BodyProxy>;
  selection: SelectionItem[];
  extrude?: ExtrudeTool;
  sketchTool?: SketchTool;
  toolWindow?: ToolWindowState;
  objectTab: BrowserTab;
  hiddenObjects: Set<string>;
  tool?: "sketch" | "extrude";
  anchor?: Point;
  drawing: boolean;
  draft?: Rectangle;
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
let toolWindow: ReturnType<typeof initToolWindow>;
let ribbon: ReturnType<typeof initRibbon>;
const status = (text: string) => {
  el("status").textContent = text;
  if (activeDocument) activeDocument.status = text;
};

const transport = editorTransport(logCommand);
const core = new Core(transport);

function controls() {
  const doc = activeDocument;
  ribbon?.render(doc?.workbench ?? "solid", doc?.sketchTool, busy || (doc?.sketchTool ? doc.sketchTool.blocking : pendingPreview), !!doc);
  button("new-sketch").disabled = busy || pendingPreview || !doc || !!doc.tool;
  button("extrude").disabled = busy || pendingPreview || !doc || !!doc.tool;
  for (const [id, name] of [
    ["new-sketch", "sketch"],
    ["extrude", "extrude"],
  ]) {
    button(id).setAttribute("aria-pressed", String(doc?.tool === name));
  }
  el("progress").hidden = !busy && !pendingPreview;
  button("sketch-view").hidden = !doc?.sketchTool?.sketch;
  setConsoleEnabled(!busy && !!doc && !doc.tool && !pendingPreview, stopConsole);
  menu?.setBusy(busy || pendingPreview);
  documentTabs?.render([...documents.values()].map(({ scene }) => ({ id: scene.id, name: scene.name ?? "Untitled" })), activeDocument?.scene.id, busy || pendingPreview);
  if (doc?.tool) {
    button("cancel").disabled = busy;
    button("apply").disabled = busy || (doc.tool === "sketch" ? !doc.sketchTool?.ready : !doc.extrude?.ready);
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

function currentSelection() { return activeDocument?.extrude?.selection ?? activeDocument?.selection ?? []; }

function drawSelection() {
  const doc = activeDocument;
  viewport.setSelection(currentSelection(), doc?.extrude?.filter ?? doc?.sketchTool?.filter ?? "all");
  drawLists();
  controls();
}

function select(item?: SelectionItem, additive = false) {
  const doc = activeDocument;
  if (!doc || busy) return;
  if (doc.sketchTool) { doc.sketchTool.click({ item, point: null, additive, picks: [], client: [0, 0] }); return; }
  if (doc.extrude) { void doc.extrude.select(item, additive); return; }
  doc.selection = changeSelection(doc.selection, item, additive);
  if (item?.kind === "plane") doc.objectTab = "Construction";
  else if (item) doc.objectTab = item.kind === "sketch" || item.kind === "region" ? "Sketches" : "Bodies";
  drawSelection();
  const count = doc.selection.length;
  status(count > 1 ? `${count} items selected` : !count ? "Ready" :
    ({ region: "Profile", sketch: "Profile", face: "Face", edge: "Edge", vertex: "Vertex", body: "Body", plane: "Plane" }[doc.selection[0].kind] + " selected"));
}

function treeNodes(): TreeNode[] {
  const doc = activeDocument;
  if (!doc) return [];
  const leaf = (id: string, label: string, kind: "body" | "sketch" | "plane"): TreeNode => ({
    id, label, kind, visible: !doc.hiddenObjects.has(id),
    selected: currentSelection().some((item) => selectionOwner(item) === id),
  });
  let children: TreeNode[] = [];
  if (doc.objectTab === "Bodies") children = [...doc.proxies.keys()].map((id, i) => leaf(id, "Body " + (i + 1), "body"));
  if (doc.objectTab === "Sketches") children = doc.entries.filter((e) => e.type === "sketch").map((entry, i) => ({
    ...leaf(entry.id, "Sketch " + (i + 1), "sketch"),
    children: (doc.sketches.get(entry.id)?.regions ?? []).map(({ region }, index) => ({
      id: region.id, label: "Region " + (index + 1), kind: "region" as const,
      visible: !doc.hiddenObjects.has(entry.id), selected: currentSelection().some((item) =>
        item.kind === "region" && item.ref.id === region.id),
    })),
  }));
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
  browser?.render(doc?.objectTab ?? browser.activeTab, treeNodes(), busy || !!(doc?.sketchTool && !doc.sketchTool.pickingSupport), doc?.scene.id);
  if (!doc) {
    el("features").replaceChildren();
    updateSceneTree([]);
    return;
  }
  const features = doc.entries.map((entry) => {
    const li = document.createElement("li");
    li.title = entry.id;
    li.textContent = entry.type === "sketch" ? "Sketch" : "Extrude";
    if (entry.type === "sketch") { li.title = "Double-click to edit " + entry.id; li.ondblclick = () => { void beginSketch(entry.id); }; }
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
  for (const entry of timeline) if (entry.type === "sketch") {
    try { doc.sketches.set(entry.id, await doc.scene.sketches.getProxy(entry.id)); }
    catch (error) { appendOutput(message(error), true); }
  }
  doc.selection = doc.selection.filter((item) => {
    if (item.kind === "body") return doc.proxies.has(item.id);
    if (item.kind === "face") return doc.proxies.get(item.ref.bodyId)?.revision === item.revision;
    if (item.kind === "edge") return doc.proxies.get(item.ref.bodyId)?.revision === item.ref.revision;
    return true;
  });
  viewport.setBodies(doc.proxies);
  viewport.setSketches(doc.sketches);
  drawSelection();
}

function closeTool(discard = true) {
  const doc = activeDocument;
  if (!doc) return;
  if (discard && doc.extrude) doc.selection = [...doc.extrude.profiles];
  doc.extrude?.close(discard);
  doc.extrude = undefined;
  doc.sketchTool?.close();
  doc.sketchTool = undefined;
  viewport.setHandles();
  const wasSketching = doc.tool === "sketch";
  if (wasSketching) doc.workbench = "solid";
  doc.tool = undefined;
  doc.anchor = undefined;
  doc.drawing = false;
  el("tool-panel").hidden = true;
  setDraft();
  setPreview();
  if (wasSketching) viewport.sketching(false);
  drawSelection();
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
  activeDocument?.extrude?.suspend();
  activeDocument?.sketchTool?.suspend();
}

function showDocument(doc?: EditorDocument) {
  activeDocument = doc;
  el("tool-panel").replaceChildren(...doc?.panel ?? []);
  el("tool-panel").hidden = !doc?.tool;
  restoreOutput(doc?.output);
  viewport.setDraft(doc?.draft);
  viewport.setPreview();
  viewport.setVisibility(doc?.hiddenObjects ?? new Set());
  viewport.setBodies(doc?.proxies ?? new Map());
  viewport.setSketches(doc?.sketches ?? new Map());
  viewport.setConstruction(doc ? Object.values(doc.scene.construction.builtin.planes) : []);
  viewport.setHandles();
  toolWindow.restore(doc?.toolWindow);
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
  drawSelection();
  doc?.extrude?.resume();
  doc?.sketchTool?.resume();
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
  activeDocument?.extrude?.suspend();
  activeDocument?.sketchTool?.suspend();
  await work(async () => {
    const created = await core.scene.create("Untitled " + (++nextDocument));
    saveDocument();
    const doc: EditorDocument = { workbench: "solid", scene: created, entries: [], sketches: new Map(), selection: [],
      proxies: new Map(), objectTab: browser.initialTab,
      hiddenObjects: new Set(Object.values(created.construction.builtin.planes).map((plane) => plane.id)),
      drawing: false, previewBodies: [], previewRemoved: [], panel: [], status: "Ready" };
    documents.set(created.id, doc);
    showDocument(doc);
  });
  const doc = activeDocument;
  if (doc?.extrude) doc.extrude.resume();
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
    doc.extrude?.close(false);
    doc.sketchTool?.suspend();
    const ids = [...documents.keys()];
    const index = ids.indexOf(id);
    documents.delete(id);
    if (activeDocument === doc) {
      const next = ids[index + 1] ?? ids[index - 1];
      showDocument(next ? documents.get(next) : undefined);
    }
  });
}

function changeVisibility(id: string, visible: boolean) {
  const doc = activeDocument;
  if (!doc || busy || doc.tool === "sketch") return;
  const regions = [...doc.sketches.values()].flatMap((s) => s.regions ?? []);
  const owner = regions.find((r) => r.region.id === id)?.region.sketchId ?? id;
  const visit = (node: TreeNode, inherited = false) => {
    const change = inherited || node.id === owner;
    if (change && ["body", "sketch", "plane"].includes(node.kind)) {
      if (visible) doc.hiddenObjects.delete(node.id); else doc.hiddenObjects.add(node.id);
      if (!visible) doc.selection = doc.selection.filter((item) => selectionOwner(item) !== node.id);
    }
    node.children?.forEach((child) => visit(child, change));
  };
  treeNodes().forEach((node) => visit(node));
  viewport.setVisibility(doc.hiddenObjects);
  drawSelection();
}

function openPanel(name: "sketch" | "extrude") {
  const panel = el("tool-panel");
  const template = el<HTMLTemplateElement>(name + "-fields");
  panel.replaceChildren(template.content.cloneNode(true));
  if (name === "extrude") {
    const icon = el("extrude").querySelector("svg")!.cloneNode(true) as SVGElement;
    icon.querySelectorAll("[id]").forEach(element => element.removeAttribute("id"));
    icon.removeAttribute("aria-labelledby");
    panel.querySelector("h2")!.prepend(icon);
  }
  panel.hidden = false;
  toolWindow.restore(activeDocument?.toolWindow);
  button("cancel").onclick = () => {
    closeTool();
    status("Ready");
  };
  controls();
  drawLists();
}
async function cancelTool() {
  const doc = activeDocument;
  if (!doc || busy) return;
  if (doc.sketchTool) await work(async () => {
    await doc.sketchTool!.cancel();
    closeTool();
    // Cancelled new sketches have no timeline entry.
    doc.sketches = new Map([...doc.sketches].filter(([id]) => doc.entries.some(e => e.id === id)));
    await refresh();
    status("Ready");
  });
  else { closeTool(); status("Ready"); }
}

async function beginSketch(editId?: string) {
  const doc = activeDocument;
  if (!doc || doc.tool || busy || pendingPreview) return;
  await work(async () => {
    const initial = doc.selection[0];
    const support: SketchSupport | undefined = initial?.kind === "plane"
      ? Object.values(doc.scene.construction.builtin.planes).find(p => p.id === initial.id)
      : initial?.kind === "face" ? initial.ref : undefined;
    doc.tool = "sketch";
    doc.workbench = "sketch";
    doc.selection = [];
    const tool = new SketchTool(el("tool-panel"), doc.scene, viewport, {
      changed(pending) {
        if (activeDocument !== doc) return;
        pendingPreview = pending;
        drawSelection();
      },
      proxy(proxy) {
        if (activeDocument !== doc) return;
        doc.sketches.set(proxy.sketch.id, proxy);
        viewport.setSketches(doc.sketches);
      },
      visibility(choosing) {
        if (activeDocument !== doc) return;
        const hidden = new Set(doc.hiddenObjects);
        if (choosing) for (const plane of Object.values(doc.scene.construction.builtin.planes)) hidden.delete(plane.id);
        if (doc.sketchTool?.sketch) hidden.delete(doc.sketchTool.sketch.id);
        viewport.setVisibility(hidden);
        drawSelection();
      },
      status(text) { if (activeDocument === doc) status(text); },
    });
    doc.sketchTool = tool;
    el("tool-panel").hidden = false;
    toolWindow.restore(doc.toolWindow);
    button("cancel").onclick = () => { void cancelTool(); };
    button("apply").onclick = () => work(async () => {
      const id = await tool.finish();
      doc.hiddenObjects.delete(id);
      doc.selection = [{kind:"sketch",id}];
      doc.objectTab = "Sketches";
      closeTool(false);
      await refresh();
      status("Sketch complete");
    });
    await tool.start(editId ? await doc.scene.sketches.get(editId) : undefined, support);
  });
}

async function beginExtrude() {
  const doc = activeDocument;
  if (!doc || doc.tool || busy || pendingPreview) return;
  await work(async () => {
    const initial = doc.selection;
    doc.selection = [];
    doc.tool = "extrude";
    openPanel("extrude");
    const tool = new ExtrudeTool(el("tool-panel"), doc.scene, transport, doc.sketches, doc.proxies, {
      changed() {
        if (activeDocument !== doc) return;
        pendingPreview = tool.pending;
        drawSelection();
      },
      preview(bodies = [], removed = []) {
        if (activeDocument !== doc || doc.extrude !== tool) return;
        setPreview(bodies, removed);
      },
      handles(items) { if (activeDocument === doc) viewport.setHandles(items); },
      status(text) { if (activeDocument === doc) status(text); },
    });
    doc.extrude = tool;
    button("apply").onclick = () => work(async () => {
      const feature = await tool.apply();
      const profiles = feature.operation.inputs.profile;
      for (const profile of Array.isArray(profiles) ? profiles : [profiles]) {
        if ("sketchId" in profile) doc.hiddenObjects.add(profile.sketchId);
      }
      doc.selection = [];
      viewport.setVisibility(doc.hiddenObjects);
      doc.objectTab = "Bodies";
      closeTool(false);
      await refresh();
      status("Extrusion created");
    });
    await tool.seed(initial);
  });
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
  document.querySelector("#extrude img")!.outerHTML = extrudeIcon;
  document.querySelector("#new-sketch img")!.outerHTML = sketchIcon;
  for (const icon of document.querySelectorAll("#solid-ribbon svg")) icon.setAttribute("aria-hidden", "true");
  document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href = faviconUrl;
  el("runtime").textContent = desktop ? "Native" : "WebAssembly";
  el("web-menu").hidden = desktop;
  viewport = new Viewport(
    el("viewport"),
    (hit) => {
      const doc = activeDocument;
      if (!doc || busy) return;
      if (doc.sketchTool) doc.sketchTool.click(hit);
      else select(hit.item, hit.additive);
    },
    (point) => { activeDocument?.sketchTool?.move(point); },
    editorTheme.definition,
  );
  toolWindow = initToolWindow(el("tool-panel"), (state) => { if (activeDocument) activeDocument.toolWindow = state; });
  editorTheme.subscribe((theme) => viewport.setTheme(theme));
  button("new-sketch").onclick = () => { void beginSketch(); };
  button("sketch-view").onclick = () => viewport.alignSketch();
  button("extrude").onclick = beginExtrude;
  ribbon = initRibbon(document.querySelector<HTMLElement>(".ribbon")!, value => {
    if (!activeDocument) return;
    activeDocument.workbench = value;
    controls();
  }, () => activeDocument?.sketchTool);
  initTooltips([document.querySelector<HTMLElement>(".ribbon")!, el("tool-panel")]);
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
      browser.render(tab, treeNodes(), busy || !!(activeDocument?.sketchTool && !activeDocument.sketchTool.pickingSupport), activeDocument?.scene.id);
    },
    onSelect(id, additive) {
      const doc = activeDocument;
      if (!doc) return;
      if (doc.proxies.has(id)) select({ kind: "body", id }, additive);
      else if (doc.sketches.has(id)) select({ kind: "sketch", id }, additive);
      else {
        const region = [...doc.sketches.values()].flatMap((sketch) => sketch.regions ?? []).find((r) => r.region.id === id);
        if (region) select({ kind: "region", ref: region.region }, additive);
        else if (Object.values(doc.scene.construction.builtin.planes).some((plane) => plane.id === id)) select({ kind: "plane", id }, additive);
      }
    },
    onActivate(id) { if (activeDocument?.sketches.has(id)) void beginSketch(id); },
    onVisibility: changeVisibility,
  });
  documentTabs = initDocumentTabs({ activate: activateDocument, close: (id) => { void closeDocument(id); }, create: () => { void newScene(); }, reorder: reorderDocument });
  await initOutputDock(runConsole, status);
  menu = initMenu({ newScene: () => { void newScene(); }, screenshot: async (mode) => {
    try {
      await saveScreenshot(await captureScreenshot(viewport, mode), mode);
    } catch (error) {
      const text = "Could not capture screenshot: " + message(error);
      status(text);
      appendOutput(text, true);
    }
  }, resetUi: () => {
    resetUiSettings();
    for (const doc of documents.values()) {
      doc.objectTab = "Bodies";
      doc.toolWindow = undefined;
    }
    toolWindow.restore();
    viewport.setCameraMode("orthographic");
    document.querySelector<HTMLInputElement>('input[name="projection"][value="orthographic"]')!.checked = true;
    drawLists();
  } });
  document.addEventListener("keydown", (e) => {
    const doc = activeDocument;
    if (e.defaultPrevented || e.target instanceof Element && e.target.closest("dialog")) return;
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
    if (e.key === "Escape" && doc?.tool) {
      if (doc.sketchTool) {
        e.preventDefault();
        doc.sketchTool.escape();
      } else if (!busy) void cancelTool();
    }
    if (e.key === "Enter" && doc?.tool === "extrude" && e.target instanceof HTMLInputElement) button("apply").click();
  });
  await newScene();
  if (!activeDocument) throw new Error(el("status").textContent || "Could not create the initial scene");
}
