declare const __PAMATCAD_COMMAND_HELP__: Record<string, { name: string; shortDescription: string }>;
const commandHelp = __PAMATCAD_COMMAND_HELP__;
const illustrations = import.meta.glob<string>("../../../doc/api/command/**/illustration.svg", { query: "?url", import: "default", eager: true });

/** One tooltip shared by the ribbon, tool window and canvas controls. */
export function initTooltips(roots: HTMLElement[]) {
  const tooltip = document.createElement("div");
  tooltip.id = "ui-tooltip";
  tooltip.className = "ui-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  const name = document.createElement("div");
  name.className = "ui-tooltip-name";
  const description = document.createElement("p");
  description.className = "ui-tooltip-description";
  const illustration = document.createElement("img");
  illustration.className = "ui-tooltip-illustration";
  illustration.width = 512;
  illustration.height = 256;
  description.hidden = illustration.hidden = true;
  tooltip.append(name, description, illustration);
  document.body.append(tooltip);
  let active: HTMLElement | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let detailTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let started = 0;
  let expanded = false;
  let warmUntil = 0;
  let pointerPressed = false;

  const trigger = (target: EventTarget | null) => {
    const element = target instanceof Element ? target.closest<HTMLElement>("[data-tooltip]") : null;
    return element && roots.some(root => root.contains(element)) ? element : undefined;
  };
  const hide = () => {
    clearTimeout(openTimer);
    clearTimeout(detailTimer);
    clearTimeout(closeTimer);
    if (!tooltip.hidden) warmUntil = performance.now() + 500;
    tooltip.hidden = true;
    expanded = false;
    if (active) {
      const describedBy = (active.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(id => id && id !== tooltip.id);
      if (describedBy.length) active.setAttribute("aria-describedby", describedBy.join(" "));
      else active.removeAttribute("aria-describedby");
    }
    active = undefined;
  };
  const valid = () => active?.isConnected && roots.some(root => root.contains(active!)) &&
    !active.closest(".sketch-live-dimensions, .sketch-dimension-input") && active.getClientRects().length &&
    getComputedStyle(active).visibility !== "hidden" && !!active.dataset.tooltip;
  const position = () => {
    if (!valid()) { hide(); return; }
    if (tooltip.hidden) return;
    const command = active!.dataset.tooltipCommand ?? "";
    const help = Object.hasOwn(commandHelp, command) ? commandHelp[command] : undefined;
    const image = help && illustrations[`../../../doc/api/command/${command.replaceAll(".", "/")}/illustration.svg`];
    name.textContent = help?.name || active!.dataset.tooltip!;
    description.hidden = !expanded || !help?.shortDescription;
    description.textContent = description.hidden ? "" : help!.shortDescription;
    illustration.hidden = !expanded || !image;
    if (!illustration.hidden) {
      illustration.alt = name.textContent + " illustration";
      if (illustration.getAttribute("src") !== image) illustration.src = image!;
    }
    tooltip.classList.toggle("ui-tooltip-expanded", !description.hidden || !illustration.hidden);
    const rect = active!.getBoundingClientRect();
    // Keep ribbon tooltips below both rows so they do not cover another tool.
    const anchor = active!.closest(".ribbon .tools")?.getBoundingClientRect() ?? rect;
    const size = tooltip.getBoundingClientRect();
    const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
    const x = Math.max(8, Math.min(rect.left + (rect.width - size.width) / 2, width - size.width - 8));
    const below = anchor.bottom + 6;
    const y = below + size.height <= height - 8 ? below : anchor.top - size.height - 6;
    tooltip.style.left = x + "px";
    tooltip.style.top = Math.max(8, Math.min(y, height - size.height - 8)) + "px";
  };
  const expandLater = () => {
    clearTimeout(detailTimer);
    if (expanded || tooltip.hidden || !active || !Object.hasOwn(commandHelp, active.dataset.tooltipCommand ?? "")) return;
    detailTimer = setTimeout(() => {
      expanded = true;
      position();
    }, Math.max(0, 500 - (performance.now() - started)));
  };
  illustration.addEventListener("load", position);
  const show = (element: HTMLElement, immediate = false) => {
    clearTimeout(closeTimer);
    if (active === element && !tooltip.hidden) { expandLater(); return; }
    hide();
    active = element;
    started = performance.now();
    const open = () => {
      if (!valid()) { hide(); return; }
      const describedBy = (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      if (!describedBy.includes(tooltip.id)) describedBy.push(tooltip.id);
      element.setAttribute("aria-describedby", describedBy.join(" "));
      tooltip.hidden = false;
      position();
      expandLater();
    };
    if (immediate || performance.now() < warmUntil) open();
    else openTimer = setTimeout(open, 100);
  };
  const leave = () => {
    if (active === document.activeElement && active?.matches(":focus-visible")) return;
    clearTimeout(openTimer);
    clearTimeout(detailTimer);
    clearTimeout(closeTimer);
    // Let the pointer cross the gap into the tooltip without losing it.
    closeTimer = setTimeout(hide, 100);
  };
  for (const root of roots) {
    root.addEventListener("pointerover", event => {
      if (event.pointerType === "touch" || event.buttons) return;
      const element = trigger(event.target);
      if (element && element !== trigger(event.relatedTarget)) show(element);
    }, true);
    root.addEventListener("pointerout", event => {
      if (trigger(event.target) === active && trigger(event.relatedTarget) !== active) leave();
    }, true);
    root.addEventListener("focusin", event => {
      const element = trigger(event.target);
      if (!pointerPressed && element?.matches(":focus-visible")) show(element, true);
    });
    root.addEventListener("focusout", event => {
      if (trigger(event.target) === active && !active?.matches(":hover") && !tooltip.matches(":hover")) hide();
    });
  }
  tooltip.addEventListener("pointerenter", () => { clearTimeout(closeTimer); expandLater(); });
  tooltip.addEventListener("pointerleave", () => {
    if (!active?.matches(":hover")) leave();
  });
  document.addEventListener("pointerdown", () => { pointerPressed = true; hide(); }, true);
  document.addEventListener("pointerup", () => { pointerPressed = false; }, true);
  document.addEventListener("pointercancel", () => { pointerPressed = false; hide(); }, true);
  // Dismiss while typing or using shortcuts without consuming their events.
  document.addEventListener("keydown", hide, true);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("visibilitychange", hide);
  window.addEventListener("resize", hide);
  window.addEventListener("blur", () => { pointerPressed = false; hide(); });
  const observer = new MutationObserver(() => { if (active) position(); });
  for (const root of roots) observer.observe(root, {
    subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "class", "style", "data-tooltip", "data-tooltip-command"],
  });
}
