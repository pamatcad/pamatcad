import collapseIcon from "./icons/collapse-left.svg?url";

export type ToolWindowState = {
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  collapsed?: boolean;
};

/** One viewport window; each document keeps its layout and live controls. */
export function initToolWindow(panel: HTMLElement, changed: (state: ToolWindowState) => void) {
  const viewport = panel.parentElement!;
  let state: ToolWindowState = {};
  let drag: { pointer: number; x: number; y: number; edge: string;
    origin: { x: number; y: number; width: number; height: number } } | undefined;

  const layout = () => {
    panel.classList.toggle("tool-window-collapsed", !!state.collapsed);
    const toggle = panel.querySelector<HTMLButtonElement>(".tool-window-toggle");
    if (toggle) {
      toggle.dataset.tooltip = state.collapsed ? "Expand tool window" : "Collapse tool window";
      toggle.setAttribute("aria-label", toggle.dataset.tooltip);
      toggle.setAttribute("aria-expanded", String(!state.collapsed));
    }
    panel.style.width = state.size ? Math.min(viewport.clientWidth, state.size.width) + "px" : "";
    panel.style.height = state.size && !state.collapsed ? Math.min(viewport.clientHeight, state.size.height) + "px" : "";
    panel.style.maxHeight = state.size ? viewport.clientHeight + "px" : "";
    panel.style.left = panel.style.top = panel.style.right = "";
    if (panel.hidden) return;
    if (state.position) {
      state.position.x = Math.max(0, Math.min(state.position.x, viewport.clientWidth - panel.offsetWidth));
      state.position.y = Math.max(0, Math.min(state.position.y, viewport.clientHeight - panel.offsetHeight));
      panel.style.left = state.position.x + "px";
      panel.style.top = state.position.y + "px";
      panel.style.right = "auto";
    }
    changed({ ...state, position: state.position && { ...state.position }, size: state.size && { ...state.size } });
  };
  const changeBounds = (origin: { x: number; y: number; width: number; height: number }, edge: string, dx: number, dy: number) => {
    if (!edge) state.position = { x: origin.x + dx, y: origin.y + dy };
    else {
      const minWidth = Math.min(280, viewport.clientWidth), minHeight = Math.min(140, viewport.clientHeight);
      let left = origin.x, top = origin.y, right = left + origin.width, bottom = top + origin.height;
      if (edge.includes("w")) left = Math.max(0, Math.min(left + dx, right - minWidth));
      if (edge.includes("e")) right = Math.min(viewport.clientWidth, Math.max(right + dx, left + minWidth));
      if (edge.includes("n")) top = Math.max(0, Math.min(top + dy, bottom - minHeight));
      if (edge.includes("s")) bottom = Math.min(viewport.clientHeight, Math.max(bottom + dy, top + minHeight));
      state.position = { x: left, y: top };
      state.size = { width: right - left, height: bottom - top };
    }
    layout();
  };
  panel.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !(event.target instanceof Element) || event.target.closest("button")) return;
    const resize = event.target.closest<HTMLElement>(".tool-window-resize");
    if (!resize && !event.target.closest(".tool-window-header")) return;
    if (resize && state.collapsed) return;
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, edge: resize?.dataset.edge ?? "",
      origin: { x: panel.offsetLeft, y: panel.offsetTop, width: panel.offsetWidth, height: panel.offsetHeight } };
    panel.setPointerCapture(event.pointerId);
    (resize?.tabIndex === 0 ? resize : panel.querySelector<HTMLElement>("h2"))?.focus({ preventScroll: true });
    event.preventDefault();
  });
  panel.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    changeBounds(drag.origin, drag.edge, event.clientX - drag.x, event.clientY - drag.y);
  });
  const stop = () => {
    const pointer = drag?.pointer;
    drag = undefined;
    if (pointer !== undefined && panel.hasPointerCapture(pointer)) panel.releasePointerCapture(pointer);
  };
  panel.addEventListener("pointerup", stop);
  panel.addEventListener("pointercancel", stop);
  panel.addEventListener("lostpointercapture", stop);
  panel.addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest(".tool-window-toggle")) return;
    state.collapsed = !state.collapsed;
    layout();
  });
  panel.addEventListener("keydown", (event) => {
    if (!(event.target instanceof Element)) return;
    const resize = event.target.closest<HTMLElement>(".tool-window-resize");
    if (!resize && !event.target.closest("h2")) return;
    const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
    if (!delta) return;
    event.preventDefault();
    changeBounds({ x: panel.offsetLeft, y: panel.offsetTop, width: panel.offsetWidth, height: panel.offsetHeight },
      resize?.dataset.edge ?? "", delta[0], delta[1]);
  });
  const observer = new ResizeObserver(layout);
  observer.observe(panel);
  observer.observe(viewport);
  return {
    restore(next?: ToolWindowState) {
      stop();
      state = { ...next, position: next?.position && { ...next.position }, size: next?.size && { ...next.size } };
      const heading = panel.querySelector<HTMLElement>(":scope > h2");
      if (heading) {
        heading.dataset.tooltip = "Move tool window (drag or arrow keys)";
        const header = document.createElement("div");
        header.className = "tool-window-header";
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "tool-window-toggle";
        toggle.setAttribute("aria-controls", "tool-window-fields tool-window-actions");
        const icon = document.createElement("img");
        icon.src = collapseIcon;
        icon.alt = "";
        toggle.append(icon);
        heading.before(header);
        header.append(heading, toggle);
        panel.querySelector<HTMLElement>(":scope > .tool-fields")!.id = "tool-window-fields";
        panel.querySelector<HTMLElement>(":scope > .actions")!.id = "tool-window-actions";
        for (const edge of ["n", "e", "s", "w", "ne", "se", "sw", "nw"]) {
          const handle = document.createElement("div");
          handle.className = "tool-window-resize";
          handle.dataset.edge = edge;
          handle.dataset.tooltip = "Resize tool window";
          if (edge === "se") {
            handle.tabIndex = 0;
            handle.setAttribute("role", "group");
            handle.setAttribute("aria-label", "Resize tool window");
            handle.dataset.tooltip = "Resize tool window (arrow keys)";
          } else handle.setAttribute("aria-hidden", "true");
          panel.append(handle);
        }
      }
      layout();
    },
  };
}
