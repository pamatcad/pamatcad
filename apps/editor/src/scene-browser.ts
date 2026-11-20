import "./scene-browser.css";
import sceneIcon from "./icons/scene.svg?url";
import groupIcon from "./icons/components.svg?url";
import sketchIcon from "./icons/sketch.svg?url";
import planeIcon from "./icons/construction.svg?url";
import { readUiSetting, writeUiSetting } from "./ui-settings";

export type BrowserTab = "Components" | "Construction" | "Bodies" | "Sketches";
export type TreeNode = {
  id: string;
  label: string;
  kind: "scene" | "group" | "body" | "sketch" | "plane";
  children?: TreeNode[];
  visible?: boolean;
  selected?: boolean;
  /** Stable expansion key when a runtime ID changes after reopening a model. */
  stateKey?: string;
};
type Callbacks = {
  onTab(tab: BrowserTab): void;
  onSelect(id: string): void;
  onVisibility(id: string, visible: boolean): void;
};
const tabNames: BrowserTab[] = ["Components", "Construction", "Bodies", "Sketches"];
const icons = { scene: sceneIcon, group: groupIcon, body: sceneIcon, sketch: sketchIcon, plane: planeIcon };

export function initSceneBrowser(callbacks: Callbacks) {
  const browser = document.querySelector<HTMLElement>("#scene-browser")!;
  const layout = browser.parentElement!;
  const toggle = browser.querySelector<HTMLButtonElement>("#toggle-browser")!;
  const tabs = browser.querySelector<HTMLElement>("#browser-tabs")!;
  const content = browser.querySelector<HTMLElement>("#browser-content")!;
  const resize = browser.querySelector<HTMLElement>("#browser-resize")!;
  const tree = document.createElement("ul");
  tree.id = "object-list";
  tree.className = "scene-tree";
  tree.setAttribute("role", "tree");
  content.replaceChildren(tree);

  const savedTab = readUiSetting<unknown>("browser.tab", "Bodies");
  let initialTab: BrowserTab = tabNames.includes(savedTab as BrowserTab) ? savedTab as BrowserTab : "Bodies";
  const savedWidth = readUiSetting<unknown>("browser.width", 220);
  let requestedWidth = typeof savedWidth === "number" && Number.isFinite(savedWidth) ? savedWidth : 220;
  let width = requestedWidth;
  let activeTab: BrowserTab = initialTab;
  let nodes: TreeNode[] = [];
  let disabled = false;
  let documentKey = "default";
  let focusedId: string | undefined;
  const selectedByDocument = new Map<string, string | undefined>();
  const expandedByDocument = new Map<string, Record<string, boolean>>();
  const buttons = new Map<string, HTMLButtonElement>();
  const branches = new Map<string, { parent?: string; children: string[]; key: string; item: HTMLLIElement }>();

  const setCollapsed = (collapsed: boolean) => {
    layout.classList.toggle("browser-collapsed", collapsed);
    tabs.hidden = content.hidden = resize.hidden = collapsed;
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.title = collapsed ? "Expand scene browser" : "Collapse scene browser";
    toggle.setAttribute("aria-label", toggle.title);
  };
  setCollapsed(readUiSetting<unknown>("browser.collapsed", false) === true);
  toggle.onclick = () => {
    const collapsed = !layout.classList.contains("browser-collapsed");
    setCollapsed(collapsed);
    writeUiSetting("browser.collapsed", collapsed);
  };

  const tabButtons = [...tabs.querySelectorAll<HTMLButtonElement>("[role=tab]")];
  for (const tab of tabButtons) {
    tab.onclick = () => {
      const name = tabNames.find((name) => tab.id === name.toLowerCase() + "-tab");
      if (name) callbacks.onTab(name);
    };
  }
  tabs.onkeydown = (event) => {
    const current = tabButtons.indexOf(event.target as HTMLButtonElement);
    const offset = { ArrowLeft: -1, ArrowRight: 1, Home: -current, End: tabButtons.length - 1 - current }[event.key];
    if (current < 0 || offset === undefined) return;
    event.preventDefault();
    const next = tabButtons[(current + offset + tabButtons.length) % tabButtons.length];
    next.click();
    next.focus();
  };

  const setWidth = (requested: number) => {
    const maximum = Math.max(220, Math.floor(layout.clientWidth * 0.55));
    width = Math.min(maximum, Math.max(220, requested));
    layout.style.setProperty("--browser-width", width + "px");
    resize.setAttribute("aria-valuenow", String(width));
    resize.setAttribute("aria-valuemax", String(maximum));
  };
  let dragStartX = 0;
  let dragStartWidth = 0;
  resize.onpointerdown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragStartX = event.clientX;
    dragStartWidth = width;
    resize.setPointerCapture(event.pointerId);
    resize.focus();
  };
  resize.onpointermove = (event) => {
    if (!resize.hasPointerCapture(event.pointerId)) return;
    setWidth(dragStartWidth + event.clientX - dragStartX);
    requestedWidth = width;
  };
  resize.onpointerup = (event) => {
    if (!resize.hasPointerCapture(event.pointerId)) return;
    resize.releasePointerCapture(event.pointerId);
    writeUiSetting("browser.width", requestedWidth);
  };
  resize.onkeydown = (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setWidth(width + (event.key === "ArrowLeft" ? -10 : 10));
    requestedWidth = width;
    writeUiSetting("browser.width", requestedWidth);
  };
  new ResizeObserver(() => setWidth(requestedWidth)).observe(layout);
  setWidth(requestedWidth);

  function expanded() {
    let state = expandedByDocument.get(documentKey);
    if (!state) {
      const stored = readUiSetting<unknown>("browser.tree." + documentKey, {});
      state = Object.create(null) as Record<string, boolean>;
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        for (const [key, value] of Object.entries(stored)) if (typeof value === "boolean") state[key] = value;
      }
      expandedByDocument.set(documentKey, state);
    }
    return state;
  }

  function setExpanded(id: string, open: boolean) {
    const branch = branches.get(id);
    if (!branch?.children.length) return;
    expanded()[branch.key] = open;
    writeUiSetting("browser.tree." + documentKey, expanded());
    draw();
    buttons.get(id)?.focus();
  }

  function focus(id: string | undefined) {
    if (!id) return;
    focusedId = id;
    for (const [key, button] of buttons) button.tabIndex = key === id ? 0 : -1;
    buttons.get(id)?.focus();
  }

  function draw() {
    const previous = document.activeElement instanceof HTMLElement && tree.contains(document.activeElement)
      ? { id: document.activeElement.dataset.nodeId, action: document.activeElement.dataset.action }
      : undefined;
    buttons.clear();
    branches.clear();
    const state = expanded();
    const rows = (items: TreeNode[], parent?: string, path: string = activeTab): HTMLLIElement[] => items.map((node) => {
      const key = path + "/" + (node.stateKey ?? node.id);
      const item = document.createElement("li");
      item.setAttribute("role", "treeitem");
      item.setAttribute("aria-label", node.label);
      item.dataset.nodeId = node.id;
      item.className = "scene-tree-item";
      const children = node.children ?? [];
      const isObject = node.kind === "body" || node.kind === "sketch" || node.kind === "plane";
      if (isObject) item.setAttribute("aria-selected", String(!!node.selected));
      const open = state[key] !== false;
      if (children.length) item.setAttribute("aria-expanded", String(open));
      branches.set(node.id, { parent, children: children.map((child) => child.id), key, item });

      const row = document.createElement("div");
      row.className = "scene-tree-row";
      row.classList.toggle("is-hidden", node.visible === false);
      row.classList.toggle("is-selected", !!node.selected);
      const expander = document.createElement("button");
      expander.type = "button";
      expander.className = "tree-expand";
      expander.dataset.nodeId = node.id;
      expander.dataset.action = "expand";
      expander.setAttribute("aria-label", (open ? "Collapse " : "Expand ") + node.label);
      expander.setAttribute("aria-expanded", String(open));
      expander.disabled = disabled || !children.length;
      expander.tabIndex = -1;
      expander.classList.toggle("is-empty", !children.length);
      expander.onclick = () => setExpanded(node.id, !open);

      const visibility = document.createElement("button");
      visibility.type = "button";
      visibility.className = "tree-visibility";
      visibility.dataset.nodeId = node.id;
      visibility.dataset.action = "visibility";
      visibility.disabled = disabled;
      visibility.setAttribute("aria-label", (node.visible === false ? "Show " : "Hide ") + node.label);
      visibility.setAttribute("aria-pressed", String(node.visible !== false));
      visibility.title = visibility.getAttribute("aria-label")!;
      visibility.onclick = () => callbacks.onVisibility(node.id, node.visible === false);

      const label = document.createElement("button");
      label.type = "button";
      label.className = "tree-label" + (isObject ? " object-row" : "");
      label.dataset.nodeId = node.id;
      label.dataset.action = "select";
      label.title = node.label;
      label.disabled = disabled;
      if (isObject) label.setAttribute("aria-pressed", String(!!node.selected));
      label.tabIndex = -1;
      const icon = document.createElement("img");
      icon.src = icons[node.kind];
      icon.alt = "";
      const text = document.createElement("span");
      text.textContent = node.label;
      label.append(icon, text);
      label.onclick = () => {
        focusedId = node.id;
        if (isObject) callbacks.onSelect(node.id);
        else if (children.length) setExpanded(node.id, !open);
      };
      label.onfocus = () => {
        focusedId = node.id;
        for (const [id, button] of buttons) button.tabIndex = id === node.id ? 0 : -1;
      };
      buttons.set(node.id, label);
      row.append(expander, visibility, label);
      item.append(row);
      if (children.length) {
        const group = document.createElement("ul");
        group.setAttribute("role", "group");
        group.hidden = !open;
        group.append(...rows(children, node.id, key));
        item.append(group);
      }
      return item;
    });
    tree.replaceChildren(...rows(nodes));
    tree.setAttribute("aria-label", activeTab);
    if (!nodes.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.setAttribute("role", "none");
      empty.textContent = "No " + activeTab.toLowerCase();
      tree.append(empty);
    }
    const visible = [...buttons].filter(([, button]) => !button.closest("[hidden]"));
    const selected = selectedByDocument.get(documentKey + "/" + activeTab);
    const focusId = [focusedId, selected, visible[0]?.[0]].find((id) => visible.some(([key]) => key === id));
    if (focusId) buttons.get(focusId)!.tabIndex = 0;
    if (previous?.id) {
      const item = branches.get(previous.id)?.item;
      const target = [...(item?.firstElementChild?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
        .find((button) => button.dataset.action === previous.action && !button.disabled);
      if (target && !target.closest("[hidden]")) target.focus();
    }
  }

  tree.onkeydown = (event) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("tree-label")) return;
    const id = target.dataset.nodeId!;
    const branch = branches.get(id)!;
    const visible = [...buttons].filter(([, button]) => !button.closest("[hidden]")).map(([id]) => id);
    const index = visible.indexOf(id);
    switch (event.key) {
      case "ArrowDown": focus(visible[Math.min(index + 1, visible.length - 1)]); break;
      case "ArrowUp": focus(visible[Math.max(index - 1, 0)]); break;
      case "Home": focus(visible[0]); break;
      case "End": focus(visible.at(-1)); break;
      case "ArrowRight":
        if (branch.children.length && expanded()[branch.key] === false) setExpanded(id, true);
        else focus(branch.children[0]);
        break;
      case "ArrowLeft":
        if (branch.children.length && expanded()[branch.key] !== false) setExpanded(id, false);
        else focus(branch.parent);
        break;
      default: return;
    }
    event.preventDefault();
  };

  function render(tab: BrowserTab, nextNodes: TreeNode[], nextDisabled = false, nextDocumentKey = "default") {
    activeTab = tab;
    nodes = nextNodes;
    disabled = nextDisabled;
    if (documentKey !== nextDocumentKey) focusedId = undefined;
    documentKey = nextDocumentKey;
    const state = expanded();
    const selectionKey = documentKey + "/" + activeTab;
    const previousSelected = selectedByDocument.get(selectionKey);
    let nextSelected: string | undefined;
    let revealed = false;
    const revealSelection = (items: TreeNode[], parents: string[], path: string) => {
      for (const node of items) {
        const key = path + "/" + (node.stateKey ?? node.id);
        if (node.selected) {
          nextSelected = node.id;
          if (node.id !== previousSelected) for (const parent of parents) {
            if (state[parent] === false) { state[parent] = true; revealed = true; }
          }
        }
        if (node.children) revealSelection(node.children, [...parents, key], key);
      }
    };
    revealSelection(nodes, [], activeTab);
    selectedByDocument.set(selectionKey, nextSelected);
    if (revealed) writeUiSetting("browser.tree." + documentKey, state);
    writeUiSetting("browser.tab", activeTab);
    for (const tabButton of tabButtons) {
      const selected = tabButton.id === activeTab.toLowerCase() + "-tab";
      tabButton.setAttribute("aria-selected", String(selected));
      tabButton.tabIndex = selected ? 0 : -1;
    }
    content.setAttribute("aria-labelledby", activeTab.toLowerCase() + "-tab");
    draw();
  }

  function reset() {
    initialTab = "Bodies";
    requestedWidth = 220;
    setWidth(requestedWidth);
    setCollapsed(false);
    expandedByDocument.clear();
    selectedByDocument.clear();
    focusedId = undefined;
    callbacks.onTab("Bodies");
  }
  window.addEventListener("pamatcad:reset-ui", reset);
  return { get initialTab() { return initialTab; }, render, reset };
}
