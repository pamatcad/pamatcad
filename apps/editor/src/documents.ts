import "./documents.css";

export function initDocumentTabs(actions: {
  activate(id: string): void;
  close(id: string): void;
  create(): void;
  reorder(id: string, beforeId: string | null): void;
}) {
  const tabs = document.getElementById("document-tabs")!;
  let drag: { id: string; pointer: number; startX: number; x: number; y: number; started: boolean; beforeId: string | null } | undefined;
  let frame = 0;
  let suppressClick = false;
  let preserveScroll = false;

  function clearDrag() {
    const pointer = drag?.pointer;
    drag = undefined;
    cancelAnimationFrame(frame);
    tabs.classList.remove("dragging-tabs");
    for (const group of tabs.querySelectorAll<HTMLElement>(".document-tab-group")) {
      group.classList.remove("dragging-tab");
      delete group.dataset.drop;
    }
    if (pointer !== undefined && tabs.hasPointerCapture(pointer)) tabs.releasePointerCapture(pointer);
  }

  function updateDrop() {
    if (!drag) return;
    const bounds = tabs.getBoundingClientRect();
    const groups = [...tabs.querySelectorAll<HTMLElement>(".document-tab-group")];
    for (const group of groups) delete group.dataset.drop;
    if (drag.y < bounds.top || drag.y > bounds.bottom) return;
    const others = groups.filter((group) => group.dataset.tabId !== drag!.id);
    const next = others.find((group) => {
      const rect = group.getBoundingClientRect();
      return drag!.x < rect.left + rect.width / 2;
    });
    drag.beforeId = next?.dataset.tabId ?? null;
    const marker = next ?? others.at(-1);
    if (marker) marker.dataset.drop = next ? "before" : "after";
  }

  function scrollDrag(previous: number) {
    frame = requestAnimationFrame((now) => {
      if (!drag?.started) return;
      const bounds = tabs.getBoundingClientRect();
      if (drag.y >= bounds.top && drag.y <= bounds.bottom) {
        const edge = 32;
        const direction = drag.x < bounds.left + edge ? -1 : drag.x > bounds.right - edge ? 1 : 0;
        tabs.scrollLeft += direction * Math.min(32, now - previous) * 0.5;
      }
      updateDrop();
      scrollDrag(now);
    });
  }

  tabs.onpointerdown = (event) => {
    clearDrag();
    suppressClick = false;
    if (event.button !== 0 || !event.isPrimary || !(event.target instanceof Element)) return;
    const tab = event.target.closest<HTMLButtonElement>('[role="tab"]');
    if (!tab || tab.disabled) return;
    drag = { id: tab.dataset.document!, pointer: event.pointerId, startX: event.clientX,
      x: event.clientX, y: event.clientY, started: false, beforeId: null };
  };
  tabs.onpointermove = (event) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!(event.buttons & 1)) { clearDrag(); return; }
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.started) {
      if (Math.abs(drag.x - drag.startX) < 5) return;
      drag.started = true;
      suppressClick = true;
      tabs.setPointerCapture(event.pointerId);
      tabs.classList.add("dragging-tabs");
      [...tabs.children].find((group) => (group as HTMLElement).dataset.tabId === drag!.id)?.classList.add("dragging-tab");
      scrollDrag(performance.now());
    }
    event.preventDefault();
    updateDrop();
  };
  tabs.onpointerup = (event) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    updateDrop();
    const { id, beforeId, started } = drag;
    const bounds = tabs.getBoundingClientRect();
    const inside = event.clientX >= bounds.left && event.clientX <= bounds.right &&
      event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    clearDrag();
    if (started && inside) {
      preserveScroll = true;
      try { actions.reorder(id, beforeId); } finally { preserveScroll = false; }
    }
  };
  tabs.onpointercancel = tabs.onlostpointercapture = clearDrag;
  tabs.ondragstart = (event) => event.preventDefault();
  tabs.addEventListener("click", (event) => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  window.addEventListener("blur", clearDrag);
  window.addEventListener("pagehide", clearDrag);
  document.getElementById("document-home")!.onclick = () => window.alert("Not implemented");
  document.getElementById("empty-new-scene")!.onclick = actions.create;
  tabs.onkeydown = (event) => {
    if (event.key === "Escape" && drag?.started) {
      event.preventDefault();
      event.stopPropagation();
      clearDrag();
      return;
    }
    const buttons = [...tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || buttons[index].disabled) return;
    if (event.key === "Delete") {
      event.preventDefault();
      actions.close(buttons[index].dataset.document!);
      return;
    }
    const offset = { ArrowLeft: -1, ArrowRight: 1, Home: -index, End: buttons.length - index - 1 }[event.key];
    if (offset === undefined) return;
    event.preventDefault();
    const next = buttons[(index + offset + buttons.length) % buttons.length];
    next.click();
    document.getElementById(next.id)?.focus();
  };
  return {
    render(documents: { id: string; name: string }[], active: string | undefined, busy: boolean) {
      const groups = [...tabs.querySelectorAll<HTMLElement>(".document-tab-group")];
      const structureChanged = groups.length !== documents.length || documents.some(({ id, name }, i) =>
        groups[i]?.dataset.tabId !== id || groups[i]?.querySelector<HTMLButtonElement>('[role="tab"]')?.title !== name);
      const activeChanged = tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.dataset.document !== active;
      if (structureChanged || activeChanged || busy) clearDrag();
      const hadFocus = tabs.contains(document.activeElement);
      const focused = tabs.querySelector<HTMLButtonElement>(":focus")?.dataset.document;
      if (structureChanged) tabs.replaceChildren(...documents.map(({ id, name }) => {
        const group = document.createElement("div");
        group.className = "document-tab-group";
        group.dataset.tabId = id;
        group.dataset.active = String(id === active);
        const tab = document.createElement("button");
        tab.type = "button";
        tab.id = "document-tab-" + id;
        tab.role = "tab";
        tab.dataset.document = id;
        tab.textContent = name;
        tab.title = name;
        tab.setAttribute("aria-selected", String(id === active));
        tab.setAttribute("aria-controls", "viewport");
        tab.tabIndex = id === active ? 0 : -1;
        tab.disabled = busy;
        tab.onclick = () => actions.activate(id);
        const close = document.createElement("button");
        close.type = "button";
        close.className = "close-document";
        close.textContent = "×";
        close.setAttribute("aria-label", "Close " + name);
        close.disabled = busy;
        close.onclick = () => actions.close(id);
        group.append(tab, close);
        return group;
      }));
      const buttons = [...tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      for (const tab of buttons) {
        const selected = tab.dataset.document === active;
        const group = tab.parentElement!;
        group.dataset.active = String(selected);
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (tab.disabled !== busy) tab.disabled = busy;
        const close = group.querySelector<HTMLButtonElement>(".close-document")!;
        if (close.disabled !== busy) close.disabled = busy;
      }
      const activeButton = buttons.find((tab) => tab.dataset.document === active);
      if (structureChanged && hadFocus) (buttons.find((tab) => tab.dataset.document === focused) ?? activeButton)?.focus({ preventScroll: true });
      if (!preserveScroll && (structureChanged || activeChanged)) activeButton?.scrollIntoView({ block: "nearest", inline: "nearest" });
      const viewport = document.getElementById("viewport")!;
      if (active) viewport.setAttribute("aria-labelledby", "document-tab-" + active);
      else viewport.removeAttribute("aria-labelledby");
      document.getElementById("empty-document")!.hidden = !!active;
      (document.getElementById("empty-new-scene") as HTMLButtonElement).disabled = busy;
    },
  };
}
