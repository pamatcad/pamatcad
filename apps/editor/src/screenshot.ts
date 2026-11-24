import { toSvg } from "html-to-image";
import type { Viewport } from "./viewport";

export type ScreenshotMode = "app" | "viewport-ui" | "viewport";

export async function captureScreenshot(viewport: Viewport, mode: ScreenshotMode): Promise<Blob> {
  await document.fonts.ready;
  // Let the capture menu close before measuring and copying the editor.
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const model = viewport.captureScreenshot({ includeUi: mode !== "viewport" });
  let canvas = model;
  if (mode !== "viewport") {
    const host = document.querySelector<HTMLElement>("#viewport")!;
    const bounds = mode === "app"
      ? document.querySelector<HTMLElement>(".document-bar")!.getBoundingClientRect()
      : host.getBoundingClientRect();
    const bottom = mode === "app" ? document.querySelector("footer")!.getBoundingClientRect().bottom : bounds.bottom;
    const width = bounds.width, height = bottom - bounds.top;
    const svgUrl = await toSvg(document.body, {
      filter: node => !(node instanceof Element) || !node.matches("#model-canvas, script, template, .sketch-cursor-symbol"),
    });
    const svg = new DOMParser().parseFromString(decodeURIComponent(svgUrl.slice(svgUrl.indexOf(",") + 1)), "image/svg+xml");
    // Composite WebGL directly at native resolution, underneath the cloned HTML controls.
    // Sending it through SVG would resample the pixels in WebKit.
    for (const selector of ["body", "#viewport"]) svg.querySelector<HTMLElement>(selector)!.style.background = "transparent";
    const inputs = [...document.querySelectorAll("input")];
    svg.querySelectorAll("input").forEach((copy, index) => {
      copy.toggleAttribute("checked", inputs[index].checked);
    });
    for (const source of document.querySelectorAll<HTMLElement>("[id], .tool-fields")) {
      if (!source.scrollTop && !source.scrollLeft) continue;
      const copy = svg.querySelector<HTMLElement>(source.id ? "#" + CSS.escape(source.id) : ".tool-fields");
      if (!copy) continue;
      const style = getComputedStyle(source);
      const content = svg.createElementNS("http://www.w3.org/1999/xhtml", "div");
      content.style.cssText = `display:${style.display};width:${source.scrollWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)}px;transform:translate(${-source.scrollLeft}px,${-source.scrollTop}px)`;
      for (const property of ["flex-direction", "gap", "align-items", "grid-template-columns", "grid-template-rows"]) {
        content.style.setProperty(property, style.getPropertyValue(property));
      }
      content.append(...copy.childNodes);
      copy.append(content);
      copy.style.display = "block";
      copy.style.overflow = "hidden";
    }
    const root = svg.documentElement;
    canvas = document.createElement("canvas");
    canvas.width = Math.floor(width * devicePixelRatio);
    canvas.height = Math.floor(height * devicePixelRatio);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create the screenshot canvas.");
    // WebKit needs a fresh SVG decode after the first rasterization to resolve embedded images.
    // Crop on the canvas: WebKit does not reliably apply viewBox offsets to foreignObject.
    for (let attempt = 0; attempt < 2; attempt++) {
      root.append(svg.createComment(`raster-${attempt}`));
      const raster = new Image();
      raster.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
      await raster.decode();
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = getComputedStyle(document.documentElement).backgroundColor;
      context.fillRect(0, 0, canvas.width, canvas.height);
      const viewportBounds = host.getBoundingClientRect();
      context.drawImage(model, (viewportBounds.left - bounds.left) * devicePixelRatio, (viewportBounds.top - bounds.top) * devicePixelRatio);
      context.drawImage(raster, -(bounds.left + scrollX) * devicePixelRatio, -(bounds.top + scrollY) * devicePixelRatio,
        Number(root.getAttribute("width")) * devicePixelRatio, Number(root.getAttribute("height")) * devicePixelRatio);
      if (!attempt) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
  }
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob);
    else reject(new Error("Could not encode the screenshot as PNG at native resolution."));
  }, "image/png"));
}

export async function saveScreenshot(blob: Blob, mode: ScreenshotMode): Promise<boolean> {
  const filename = `PamatCAD-${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  if (import.meta.env.MODE === "desktop") {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<boolean>("save_screenshot", { filename, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) });
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Keep the URL alive while the browser starts its download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
