import "./menu.css";
import type { ScreenshotMode } from "./screenshot";

declare const __PAMATCAD_VERSION__: string;
declare const __OCCT_VERSION__: string;

export function initMenu(actions: { newScene: () => void; resetUi: () => void; screenshot: (mode: ScreenshotMode) => Promise<void> }) {
  const native = import.meta.env.MODE === "desktop";
  const nav = document.querySelector<HTMLElement>("#web-menu")!;
  nav.innerHTML = `
    <details>
      <summary aria-controls="file-menu-items" aria-expanded="false">File</summary>
      <div class="menu-items" id="file-menu-items">
        <button id="menu-new" type="button" data-action="new">New scene</button>
      </div>
    </details>
    <details>
      <summary aria-controls="tools-menu-items" aria-expanded="false">Tools</summary>
      <div class="menu-items" id="tools-menu-items">
        <details>
          <summary aria-controls="screenshot-menu-items" aria-expanded="false">Capture screenshot <span aria-hidden="true">›</span></summary>
          <div class="menu-items" id="screenshot-menu-items">
            <button type="button" data-action="screenshot-app">Full app</button>
            <button type="button" data-action="screenshot-viewport-ui">Viewport with UI</button>
            <button type="button" data-action="screenshot-viewport">Viewport without UI</button>
          </div>
        </details>
      </div>
    </details>
    <details>
      <summary aria-controls="help-menu-items" aria-expanded="false">Help</summary>
      <div class="menu-items" id="help-menu-items">
        <button id="menu-reset-ui" type="button" data-action="reset-ui">Reset UI</button>
        <button id="menu-about" type="button" data-action="about">About</button>
      </div>
    </details>`;
  nav.hidden = native;
  const menus = [...nav.querySelectorAll("details")];
  const topMenus = [...nav.querySelectorAll<HTMLDetailsElement>(":scope > details")];
  const captures = [...nav.querySelectorAll<HTMLButtonElement>('[data-action^="screenshot-"]')];
  let capturing = false;
  const newScene = nav.querySelector<HTMLButtonElement>("#menu-new")!;
  const resetUi = nav.querySelector<HTMLButtonElement>("#menu-reset-ui")!;
  const about = document.createElement("dialog");
  about.id = "about";
  about.setAttribute("aria-labelledby", "about-title");
  about.innerHTML = `
    <h2 id="about-title">About PamatCAD</h2>
    <p id="about-versions"></p>
    <p><a href="https://github.com/pamatcad/pamatcad" target="_blank" rel="noopener noreferrer">PamatCAD on GitHub</a></p>
    <p class="error" id="about-error" role="status" hidden></p>
    <div class="about-actions">
      <form method="dialog"><button autofocus>Close</button></form>
    </div>`;
  about.querySelector("#about-versions")!.textContent = `PamatCAD ${__PAMATCAD_VERSION__} · OCCT ${__OCCT_VERSION__}`;
  document.body.append(about);
  about.addEventListener("keydown", (event) => {
    if (event.key === "Escape") event.stopPropagation();
  });
  const error = about.querySelector<HTMLElement>("#about-error")!;
  if (native) {
    about.querySelector<HTMLAnchorElement>("a")!.onclick = async (event) => {
      event.preventDefault();
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("open_project");
      } catch (failure) {
        error.textContent = "Could not open the project link: " + String(failure);
        error.hidden = false;
      }
    };
  }

  const closeMenus = () => { for (const menu of menus) menu.open = false; };
  const run = (id: string) => {
    closeMenus();
    if (id === "new" && !newScene.disabled) actions.newScene();
    if (id === "reset-ui" && !resetUi.disabled) actions.resetUi();
    const mode = id.slice("screenshot-".length);
    if (id.startsWith("screenshot-") && ["app", "viewport-ui", "viewport"].includes(mode) && !capturing) {
      capturing = true;
      captures.forEach(item => { item.disabled = true; });
      void actions.screenshot(mode as ScreenshotMode).finally(() => {
        capturing = false;
        captures.forEach(item => { item.disabled = false; });
      });
    }
    if (id === "about" && !about.open) {
      error.hidden = true;
      about.showModal();
    }
  };
  for (const item of nav.querySelectorAll<HTMLButtonElement>("[data-action]")) {
    item.onclick = () => run(item.dataset.action!);
  }
  for (const menu of menus) {
    menu.addEventListener("toggle", () => {
      menu.querySelector("summary")!.setAttribute("aria-expanded", String(menu.open));
      if (menu.open) for (const other of menus) {
        if (other !== menu && other.parentElement === menu.parentElement) other.open = false;
      }
      else for (const child of menu.querySelectorAll("details")) child.open = false;
    });
  }
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Node && !nav.contains(event.target)) closeMenus();
  });
  document.addEventListener("focusin", (event) => {
    if (event.target instanceof Node && !nav.contains(event.target)) closeMenus();
  });
  nav.addEventListener("keydown", (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const menu = event.target.closest("details");
    if (!menu) return;
    const summary = menu.querySelector("summary")!;
    const buttons = [...menu.querySelectorAll<HTMLElement>(":scope > .menu-items > button:not(:disabled), :scope > .menu-items > details > summary")];
    const parent = menu.parentElement?.closest("details");
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (parent && !menu.open) {
        parent.open = false;
        parent.querySelector("summary")!.focus();
        return;
      }
      if (parent) menu.open = false;
      else closeMenus();
      summary.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      menu.open = true;
      const current = buttons.indexOf(event.target);
      const next = current < 0
        ? event.key === "ArrowDown" ? 0 : buttons.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      if (parent) {
        menu.open = event.key === "ArrowRight";
        if (menu.open) buttons[0]?.focus();
        else summary.focus();
        return;
      }
      const offset = event.key === "ArrowLeft" ? -1 : 1;
      const next = topMenus[(topMenus.indexOf(menu) + offset + topMenus.length) % topMenus.length];
      const wasOpen = menu.open;
      closeMenus();
      next.open = wasOpen;
      next.querySelector("summary")!.focus();
    }
  });
  if (native) {
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<string>("editor-menu", (event) => run(event.payload)))
      .then((unlisten) => window.addEventListener("pagehide", unlisten, { once: true }))
      .catch((failure) => console.error("Could not connect the application menu", failure));
  }
  return {
    setBusy(busy: boolean) {
      newScene.disabled = resetUi.disabled = busy;
    },
  };
}
