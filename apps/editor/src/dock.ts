import stylesheet from "./style.css?url";
import { editorTheme } from "./theme";

// Keep references in the editor. The same panel (including its handlers and draft)
// is adopted by the detached window and moved back when that window closes.
const panel = document.querySelector<HTMLElement>("#output-dock")!;
const toggle = document.querySelector<HTMLButtonElement>("#toggle-output")!;
const locationButton = panel.querySelector<HTMLButtonElement>("#dock-location")!;
const input = panel.querySelector<HTMLInputElement>("#js")!;
const output = panel.querySelector<HTMLElement>("#console-output")!;
const log = panel.querySelector<HTMLElement>("#log")!;
const tree = panel.querySelector<HTMLElement>("#tree")!;
const footer = document.querySelector("footer")!;
let detached: Window | null = null;
let releaseTheme: (() => void) | undefined;

export function appendOutput(text: string, error = false) {
  const line = document.createElement("div");
  line.className = error ? "entry error" : "entry";
  line.textContent = text;
  output.append(line);
  output.scrollTop = output.scrollHeight;
}

export function logCommand(method: string, params: unknown) {
  const row = document.createElement("details");
  const title = document.createElement("summary");
  const data = document.createElement("pre");
  title.textContent = method;
  data.textContent = JSON.stringify(params, null, 2);
  row.append(title, data);
  log.append(row);
}

export function updateSceneTree(groups: [string, string[]][]) {
  tree.replaceChildren(...groups.map(([title, items]) => {
    const branch = document.createElement("details");
    branch.open = true;
    const summary = document.createElement("summary");
    summary.textContent = title + " (" + items.length + ")";
    branch.append(summary);
    for (const id of items) {
      const item = document.createElement("div");
      item.textContent = "  " + id;
      branch.append(item);
    }
    return branch;
  }));
}

export function setConsoleEnabled(enabled: boolean) {
  input.disabled = !enabled;
}

function showDock(open: boolean) {
  panel.hidden = !open;
  document.body.classList.toggle("output-open", open);
  toggle.setAttribute("aria-expanded", String(open));
}

function dockBack() {
  releaseTheme?.();
  releaseTheme = undefined;
  if (!detached) return;
  detached = null;
  footer.before(panel);
  locationButton.textContent = "Pop out";
  toggle.title = "";
  showDock(true);
  locationButton.focus();
}

export async function initOutputDock(run: (source: string) => void, report: (message: string) => void) {
  const tabs = panel.querySelectorAll<HTMLButtonElement>("[data-dock]");
  for (const tab of tabs) {
    tab.onclick = () => {
      for (const other of tabs) {
        other.setAttribute("aria-selected", String(other === tab));
        panel.querySelector<HTMLElement>("#" + other.dataset.dock)!.hidden = other !== tab;
      }
    };
  }
  panel.querySelector<HTMLFormElement>("#console-form")!.onsubmit = (event) => {
    event.preventDefault();
    const source = input.value.trim();
    if (!source || input.disabled) return;
    input.value = "";
    run(source);
  };

  const native = import.meta.env.MODE === "desktop";
  let closeWindow = (popup: Window) => popup.close();
  if (native) {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    closeWindow = () => {
      void invoke("close_output").catch((error) => report(String(error)));
    };
    await listen("output-closed", dockBack);
  }
  toggle.onclick = () => {
    if (detached) closeWindow(detached);
    else showDock(panel.hidden);
  };
  locationButton.onclick = () => {
    if (detached) {
      closeWindow(detached);
      return;
    }
    const popup = window.open("about:blank", "_blank", "popup,width=720,height=420");
    if (!popup) {
      report(native ? "Could not open the output window." : "Allow pop-ups to open the output window.");
      return;
    }
    try {
      const doc = popup.document;
      releaseTheme = editorTheme.apply(doc);
      doc.title = "PamatCAD · Output";
      const css = doc.createElement("link");
      css.rel = "stylesheet";
      css.href = new URL(stylesheet, document.baseURI).href;
      doc.head.append(css);
      doc.body.className = "output-window";
      doc.body.append(panel);
      detached = popup;
      document.body.classList.remove("output-open");
      toggle.setAttribute("aria-expanded", "false");
      toggle.title = "Dock output back";
      locationButton.textContent = "Dock back";
      popup.addEventListener("pagehide", () => {
        if (detached !== popup) return;
        // Keep the panel alive until Tauri confirms the native window has closed.
        if (native) footer.before(panel);
        else dockBack();
      }, { once: true });
      locationButton.focus();
    } catch (error) {
      closeWindow(popup);
      dockBack();
      report(String(error));
    }
  };
  window.addEventListener("pagehide", () => {
    if (detached) closeWindow(detached);
  });
}
