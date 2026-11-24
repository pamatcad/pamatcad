import crosshair from "./icons/cursors/crosshair.svg?url";

const symbols = import.meta.glob<string>("./icons/cursors/*.svg", { query: "?url", import: "default", eager: true });

/** Canvas-local pointer feedback, independent of geometry updates and rendering. */
export class SketchCursor {
  private badge = document.createElement("img");
  private pointer?: PointerEvent;
  private drawing = false;
  private symbol?: string;

  constructor(private canvas: HTMLCanvasElement, private blocked: (event: PointerEvent) => boolean) {
    this.badge.className = "sketch-cursor-symbol";
    this.badge.alt = "";
    this.badge.setAttribute("aria-hidden", "true");
    this.badge.hidden = true;
    canvas.parentElement!.append(this.badge);
    const move = (event: PointerEvent) => { this.pointer = event; this.update(); };
    for (const event of ["pointerenter", "pointermove", "pointerdown", "pointerup"] as const) canvas.addEventListener(event, move, true);
    const leave = () => { this.pointer = undefined; this.update(); };
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("pointercancel", leave);
    window.addEventListener("blur", leave);
  }

  set(symbol?: string, drawing = false) {
    if (symbol !== this.symbol) {
      this.symbol = symbol;
      if (symbol) this.badge.src = symbols[`./icons/cursors/${symbol}.svg`];
      else this.badge.removeAttribute("src");
    }
    this.drawing = drawing;
    this.update();
  }

  private update() {
    const event = this.pointer;
    const visible = !!event && event.pointerType !== "touch" && !(event.buttons & ~1) && !this.blocked(event) && !!this.symbol;
    this.badge.hidden = !visible;
    this.canvas.style.cursor = visible && this.drawing ? `url("${crosshair}") 8 8, crosshair` : "default";
    if (visible) {
      this.badge.style.left = `${event.clientX + 12}px`;
      this.badge.style.top = `${event.clientY + 12}px`;
    }
  }
}
