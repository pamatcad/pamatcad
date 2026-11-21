export type ToolWindowPosition = { x: number; y: number };

/** One viewport window; the owning document keeps its position. */
export function initToolWindow(panel: HTMLElement, changed: (position: ToolWindowPosition) => void) {
  let position: ToolWindowPosition | undefined;
  let drag: { pointer: number; x: number; y: number; origin: ToolWindowPosition } | undefined;
  const clamp = () => {
    if (!position || panel.hidden) return;
    position.x = Math.max(0, Math.min(position.x, panel.parentElement!.clientWidth - panel.offsetWidth));
    position.y = Math.max(0, Math.min(position.y, panel.parentElement!.clientHeight - panel.offsetHeight));
    panel.style.left = position.x + "px";
    panel.style.top = position.y + "px";
    panel.style.right = "auto";
    changed({ ...position });
  };
  panel.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !(event.target instanceof Element) || !event.target.closest("h2")) return;
    position = { x: panel.offsetLeft, y: panel.offsetTop };
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, origin: { ...position } };
    panel.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  panel.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    position = { x: drag.origin.x + event.clientX - drag.x, y: drag.origin.y + event.clientY - drag.y };
    clamp();
  });
  const stop = () => { drag = undefined; };
  panel.addEventListener("pointerup", stop);
  panel.addEventListener("pointercancel", stop);
  panel.addEventListener("lostpointercapture", stop);
  panel.addEventListener("keydown", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest("h2")) return;
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta) return;
    event.preventDefault();
    position = { x: panel.offsetLeft + delta[0] * 10, y: panel.offsetTop + delta[1] * 10 };
    clamp();
  });
  const observer = new ResizeObserver(clamp);
  observer.observe(panel);
  observer.observe(panel.parentElement!);
  return {
    restore(next?: ToolWindowPosition) {
      drag = undefined;
      position = next && { ...next };
      panel.style.left = panel.style.top = panel.style.right = "";
      clamp();
    },
  };
}
