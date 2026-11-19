export function initSceneBrowser() {
  const browser = document.querySelector<HTMLElement>("#scene-browser")!;
  const layout = browser.parentElement!;
  const toggle = browser.querySelector<HTMLButtonElement>("#toggle-browser")!;
  const tabs = browser.querySelector<HTMLElement>("#browser-tabs")!;
  const content = browser.querySelector<HTMLElement>("#browser-content")!;
  const resize = browser.querySelector<HTMLElement>("#browser-resize")!;
  let width = browser.getBoundingClientRect().width;

  toggle.onclick = () => {
    const collapsed = layout.classList.toggle("browser-collapsed");
    tabs.hidden = content.hidden = resize.hidden = collapsed;
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.title = collapsed ? "Expand scene browser" : "Collapse scene browser";
    toggle.setAttribute("aria-label", toggle.title);
  };

  const tabButtons = [...tabs.querySelectorAll<HTMLButtonElement>("[role=tab]")];
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
    const maximum = Math.floor(layout.clientWidth * 0.55);
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
    if (resize.hasPointerCapture(event.pointerId)) setWidth(dragStartWidth + event.clientX - dragStartX);
  };
  resize.onpointerup = (event) => {
    if (resize.hasPointerCapture(event.pointerId)) resize.releasePointerCapture(event.pointerId);
  };
  resize.onkeydown = (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setWidth(width + (event.key === "ArrowLeft" ? -10 : 10));
  };
  new ResizeObserver(() => setWidth(width)).observe(layout);
}
