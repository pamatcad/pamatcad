import "./loading.css";
import logoUrl from "../../../doc/media/logo-letters.svg?url";
import { editorTheme } from "./theme";

const screen = document.getElementById("loading-screen")!;
const message = document.getElementById("loading-message")!;
const progress = document.getElementById("loading-progress")!;
const errorMessage = document.getElementById("loading-error")!;
const reload = document.getElementById("reload-editor")!;

editorTheme.apply(document);
screen.querySelector<HTMLImageElement>(".loading-logo")!.src = logoUrl;
reload.onclick = () => window.location.reload();

async function start() {
  if (import.meta.env.MODE === "desktop") {
    const { invoke } = await import("@tauri-apps/api/core");
    // Show the styled loading screen before importing the editor. A hidden native
    // window may suspend animation frames, so it must be shown before awaiting one.
    await invoke("show_main_window");
  }
  await new Promise<void>((resolve) => {
    // Background browser tabs may not receive animation frames.
    const fallback = setTimeout(resolve, 100);
    requestAnimationFrame(() => {
      clearTimeout(fallback);
      setTimeout(resolve, 0);
    });
  });
  message.textContent = "Starting geometry engine…";
  const { startEditor } = await import("./editor");
  await startEditor();
  screen.setAttribute("aria-busy", "false");
  screen.hidden = true;
  delete document.body.dataset.loading;
}

void start().catch((error: unknown) => {
  screen.setAttribute("aria-busy", "false");
  message.textContent = "PamatCAD could not start";
  progress.hidden = true;
  errorMessage.textContent = error instanceof Error ? error.message : String(error);
  errorMessage.hidden = reload.hidden = false;
  reload.focus();
});
