import type { Scene } from "@pamatcad/sdk";
export type FontFaceInfo = {
  id: string; family: string; style: string; weight: number; italic: boolean;
  weights?: number[]; variableItalic?: boolean; postscriptName?: string;
};
export type FontData = { fontBase64?: string; fontIndex?: number };
type LocalFont = { family: string; style: string; postscriptName: string; blob(): Promise<Blob> };
type FontWindow = Window & { queryLocalFonts?: () => Promise<LocalFont[]> };
export function unsupportedFonts() {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent) ? "Edge" : /OPR\//.test(agent) ? "Opera" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "this browser";
  return `Accessing system fonts is not supported in ${browser}, use Chrome or import a font`;
}
export const bundledFont: FontFaceInfo = { id: "bundled:roboto", family: "Roboto", style: "Regular", weight: 400, italic: false, weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] };
const faces = new Map<string, FontFaceInfo>();
const data = new Map<string, Promise<FontData>>();
const browserFonts = new Map<string, LocalFont>();
type DocumentFonts = { faces: Map<string, FontFaceInfo>; data: Map<string, Promise<FontData>>; stored: Map<string, FontFaceInfo> };
const documents = new WeakMap<Scene, DocumentFonts>();
function documentFonts(scene: Scene) {
  let catalog = documents.get(scene);
  if (!catalog) {
    catalog = { faces: new Map([[bundledFont.id, bundledFont]]), data: new Map(), stored: new Map() };
    documents.set(scene, catalog);
  }
  return catalog;
}
let importedId = 0;

export function encodeFont(bytes: Uint8Array) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
function decodeFont(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }

// Read only the SFNT metadata needed by the picker. Glyph shaping stays in the core.
function inspectFont(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const count = tag(0) === "ttcf" ? view.getUint32(8) : 1;
  if (!count || count > 4096) throw new Error("Invalid font collection");
  const offsets = tag(0) === "ttcf" ? Array.from({ length: count }, (_, i) => view.getUint32(12 + 4 * i)) : [0];
  return offsets.map((offset, fontIndex) => {
    const signature = view.getUint32(offset);
    if (![0x00010000, 0x4f54544f, 0x74727565].includes(signature)) throw new Error("Select an OpenType or TrueType font");
    const tables = new Map<string, number>();
    for (let i = 0; i < view.getUint16(offset + 4); i++) {
      const entry = offset + 12 + i * 16, start = view.getUint32(entry + 8), length = view.getUint32(entry + 12);
      if (start + length > bytes.length) throw new Error("Invalid font table");
      tables.set(tag(entry), start);
    }
    const names = new Map<number, { value: string; priority: number }>();
    const name = tables.get("name");
    if (name !== undefined) {
      const storage = name + view.getUint16(name + 4);
      for (let i = 0; i < view.getUint16(name + 2); i++) {
        const entry = name + 6 + i * 12, platform = view.getUint16(entry), language = view.getUint16(entry + 4), id = view.getUint16(entry + 6);
        if (![1, 2, 6, 16, 17].includes(id)) continue;
        const start = storage + view.getUint16(entry + 10), length = view.getUint16(entry + 8);
        const unicode = platform === 0 || platform === 3;
        const priority = (unicode ? 2 : 0) + (language === 0x409 || language === 0 ? 1 : 0);
        if ((names.get(id)?.priority ?? -1) > priority) continue;
        const value = new TextDecoder(unicode ? "utf-16be" : "macintosh").decode(bytes.subarray(start, start + length));
        names.set(id, { value, priority });
      }
    }
    const os2 = tables.get("OS/2"), head = tables.get("head");
    const weight = os2 === undefined ? 400 : view.getUint16(os2 + 4);
    const italic = os2 !== undefined ? !!(view.getUint16(os2 + 62) & 0x201) : head !== undefined && !!(view.getUint16(head + 44) & 2);
    let weights: number[] | undefined, variableItalic = false;
    const fvar = tables.get("fvar");
    if (fvar !== undefined) {
      const start = fvar + view.getUint16(fvar + 4), count = view.getUint16(fvar + 8), stride = view.getUint16(fvar + 10);
      for (let i = 0; i < count; i++) {
        const axis = start + i * stride, min = view.getInt32(axis + 4) / 65536, max = view.getInt32(axis + 12) / 65536;
        if (tag(axis) === "wght") weights = [...new Set([min, max, weight, ...Array.from({ length: 10 }, (_, j) => (j + 1) * 100)])].filter(w => w >= min && w <= max).sort((a, b) => a - b);
        if (tag(axis) === "ital" && min <= 0 && max >= 1 || tag(axis) === "slnt" && min <= 0 && max >= 0 && min !== max) variableItalic = true;
      }
    }
    return { fontIndex, family: names.get(16)?.value ?? names.get(1)?.value ?? "Imported font", style: names.get(17)?.value ?? names.get(2)?.value ?? "Regular", postscriptName: names.get(6)?.value, weight, italic, weights, variableItalic };
  });
}
function nameWeight(style: string) {
  const name = style.toLowerCase().replace(/[ -]/g, "");
  for (const [word, weight] of [["thin", 100], ["extralight", 200], ["ultralight", 200], ["semibold", 600], ["demibold", 600], ["extrabold", 800], ["ultrabold", 800], ["black", 900], ["heavy", 900], ["light", 300], ["medium", 500], ["bold", 700]] as const) if (name.includes(word)) return weight;
  return 400;
}
export const fonts = {
  get supported() { return import.meta.env.MODE === "desktop" || typeof (window as FontWindow).queryLocalFonts === "function"; },
  all: (scene: Scene, source: "document" | "system") => [...(source === "document" ? documentFonts(scene).faces : faces).values()],
  clearLocal() { faces.clear(); browserFonts.clear(); data.clear(); },
  async listLocal() {
    if (import.meta.env.MODE === "desktop") {
      const { invoke } = await import("@tauri-apps/api/core");
      const local = await invoke<FontFaceInfo[]>("list_fonts");
      faces.clear();
      for (const face of local) faces.set("native:" + face.id, { ...face, id: "native:" + face.id });
    } else {
      const query = (window as FontWindow).queryLocalFonts;
      if (!query) throw new Error(unsupportedFonts());
      // Call directly from the click handler, before any asynchronous work consumes activation.
      const local = await query.call(window);
      faces.clear(); browserFonts.clear();
      for (const font of local) {
        const id = "local:" + font.postscriptName;
        browserFonts.set(id, font);
        faces.set(id, { id, family: font.family, style: font.style, postscriptName: font.postscriptName, weight: nameWeight(font.style), italic: /italic|oblique/i.test(font.style) });
      }
    }
    return [...faces.values()];
  },
  import(scene: Scene, bytes: Uint8Array) {
    const catalog = documentFonts(scene);
    const fontBase64 = encodeFont(bytes), imported = inspectFont(bytes).map(face => ({ ...face, id: "imported:" + ++importedId }));
    for (const face of imported) { catalog.faces.set(face.id, face); catalog.data.set(face.id, Promise.resolve({ fontBase64, fontIndex: face.fontIndex })); catalog.stored.set(face.fontIndex + ":" + fontBase64, face); }
    return imported;
  },
  restore(scene: Scene, value: FontData, family = "Roboto") {
    if (!value.fontBase64) return bundledFont;
    const catalog = documentFonts(scene);
    const key = (value.fontIndex ?? 0) + ":" + value.fontBase64;
    const stored = catalog.stored.get(key);
    if (stored) return stored;
    const bytes = decodeFont(value.fontBase64);
    const info = inspectFont(bytes).find(face => face.fontIndex === (value.fontIndex ?? 0));
    if (!info) throw new Error("Font face does not exist in the collection");
    // Match stored bytes rather than a family name, which may name a different installed font.
    const face = { ...info, family: info.family || family, id: "document:" + ++importedId };
    catalog.faces.set(face.id, face); catalog.data.set(face.id, Promise.resolve(value)); catalog.stored.set(key, face);
    return face;
  },
  async load(scene: Scene, id: string): Promise<FontData> {
    if (id === bundledFont.id) return {};
    const stored = documentFonts(scene).data.get(id);
    if (stored) return stored;
    let pending = data.get(id);
    if (!pending) {
      pending = (async () => {
        let result: FontData;
        if (id.startsWith("native:")) {
          const { invoke } = await import("@tauri-apps/api/core");
          result = await invoke<FontData>("load_font", { id: id.slice(7) });
        } else {
          const font = browserFonts.get(id);
          if (!font) throw new Error("Selected font is unavailable");
          result = { fontBase64: encodeFont(new Uint8Array(await (await font.blob()).arrayBuffer())) };
        }
        const metadata = inspectFont(decodeFont(result.fontBase64!));
        const info = id.startsWith("local:") ? metadata.find(face => face.postscriptName === faces.get(id)?.postscriptName) ?? (metadata.length === 1 ? metadata[0] : undefined) : metadata.find(face => face.fontIndex === result.fontIndex);
        if (!info) throw new Error("Selected font face was not found");
        Object.assign(faces.get(id)!, info);
        return { ...result, fontIndex: info.fontIndex };
      })();
      data.set(id, pending);
      pending.catch(() => data.delete(id));
    }
    return pending;
  },
};
