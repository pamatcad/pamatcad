declare const __PAMATCAD_VERSION__: string;
declare const __OCCT_VERSION__: string;

type MemoryFootprint = { bytes: number; processes: number };

export function initStatusLine() {
  document.getElementById("versions")!.textContent = `PamatCAD ${__PAMATCAD_VERSION__} OCCT ${__OCCT_VERSION__}`;
  const memory = document.getElementById("memory-footprint")!;
  if (import.meta.env.MODE !== "desktop") {
    memory.title = "The browser does not expose total app memory usage.";
    return;
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const footprint = await invoke<MemoryFootprint | null>("memory_footprint");
      if (footprint) {
        memory.textContent = `${(footprint.bytes / 1e9).toFixed(2)} GB RAM`;
        memory.title = `Estimated physical footprint of PamatCAD and its OS helpers (${footprint.processes} processes), including compressed memory. 1 GB = 1,000,000,000 bytes.`;
      } else {
        memory.textContent = "RAM unavailable";
        memory.title = "Total app memory cannot be measured on this platform or for this launch method.";
      }
    } catch {
      memory.textContent = "RAM unavailable";
      memory.title = "Could not read total app memory usage.";
    } finally {
      if (!stopped) timer = setTimeout(poll, 1000);
    }
  };
  window.addEventListener("pagehide", () => {
    stopped = true;
    clearTimeout(timer);
  }, { once: true });
  void poll();
}
