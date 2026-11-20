const prefix = "pamatcad.ui.";

export function readUiSetting<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(prefix + key);
    return stored === null ? fallback : JSON.parse(stored);
  } catch {
    return fallback;
  }
}

export function writeUiSetting(key: string, value: unknown) {
  try { localStorage.setItem(prefix + key, JSON.stringify(value)); } catch { /* Storage may be disabled. */ }
}

export function resetUiSettings() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
  } catch { /* In-memory controls still reset when storage is unavailable. */ }
  window.dispatchEvent(new Event("pamatcad:reset-ui"));
}
