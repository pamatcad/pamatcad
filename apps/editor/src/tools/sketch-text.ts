import type { Scene, TextParameters } from "@pamatcad/sdk";
import { bundledFont, fonts, unsupportedFonts, type FontFaceInfo } from "../runtime/fonts";
const icons = import.meta.glob<string>("../icons/text-*.svg", { query: "?raw", import: "default", eager: true });
const weightNames: Record<number, string> = { 100: "Thin", 200: "Extra light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Extra bold", 900: "Black", 1000: "Extra black" };

export class TextControls {
  private face = bundledFont;
  private weight = 400;
  private italic = false;
  private horizontal: TextParameters["horizontal"] = "left";
  private vertical: TextParameters["vertical"] = "baseline";
  private loading = Promise.resolve();
  private revision = 0;
  private regularWeight = 400;
  private source: "document" | "system" = "document";
  private permission?: PermissionStatus;
  private localAvailable = false;
  private localLoading = false;
  private localRequested = false;
  private disposed = false;
  private embedded?: FontFaceInfo;
  private hydrated = false;
  constructor(private panel: HTMLElement, private scene: Scene, private changed: () => void, private error: (message: string) => void) {
    // Keep this document's controls even while its tool window is detached.
    this.panel = panel.querySelector<HTMLElement>(".sketch-text-controls")!;
    for (const [group, values] of [["horizontal", ["left", "center", "right"]], ["vertical", ["top", "middle", "bottom", "baseline"]]] as const) {
      for (const value of values) this.button("sketch-" + group, value, "text-align-" + value, "Align " + value, () => {
        if (group === "horizontal") this.horizontal = value as TextParameters["horizontal"];
        else this.vertical = value as TextParameters["vertical"];
        this.render(); this.changed();
      });
    }
    this.button("sketch-font-styles", "bold", "text-bold", "Bold", () => {
      if (this.weight >= 700) this.weight = this.regularWeight;
      else { this.regularWeight = this.weight; this.weight = 700; }
      this.choose(this.face.family);
    });
    this.button("sketch-font-styles", "italic", "text-italic", "Italic", () => { this.italic = !this.italic; this.choose(this.face.family); });
    this.select("sketch-weight").onchange = () => { this.weight = Number(this.select("sketch-weight").value); this.choose(this.face.family); };
    this.select("sketch-font-family").onchange = () => {
      const [source, family] = JSON.parse(this.select("sketch-font-family").value);
      this.source = source; this.weight = 400; this.italic = false; this.choose(family);
    };
    this.get("sketch-local-fonts").onclick = () => this.loadLocal();
    this.get("sketch-font-import").onclick = () => this.get("sketch-font").click();
    (this.get("sketch-font") as HTMLInputElement).onchange = () => {
      const input = this.get("sketch-font") as HTMLInputElement, file = input.files?.[0];
      if (!file) return;
      const revision = ++this.revision;
      this.loading = (async () => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (this.disposed || revision !== this.revision) return;
        const imported = fonts.import(this.scene, bytes);
        this.source = "document";
        this.face = imported[0]; this.weight = this.face.weight; this.italic = this.face.italic;
        this.render();
      })().catch(error => { if (!this.disposed && revision === this.revision) this.error(String(error)); })
        .finally(() => { input.value = ""; });
      this.changed();
    };
    this.render();
    this.accessMessage();
    if (import.meta.env.MODE === "desktop") this.loadLocal();
    else if (fonts.supported && navigator.permissions) {
      void navigator.permissions.query({ name: "local-fonts" as PermissionName }).then(permission => {
        if (this.disposed) return;
        this.permission = permission;
        permission.addEventListener("change", this.permissionChanged);
        this.permissionChanged();
      }).catch(() => {}); // Enumeration still works in browsers without a permission descriptor.
    }
  }
  private accessMessage(message?: string) {
    const local = this.get("sketch-local-fonts");
    const desktop = import.meta.env.MODE === "desktop";
    this.get("sketch-font-access").hidden = this.localAvailable && !message;
    this.get("sketch-font-message").textContent = message ?? (!fonts.supported ? unsupportedFonts() : desktop || this.permission?.state === "granted" ? "" : "No permission to access local fonts. ");
    local.hidden = !fonts.supported;
    local.textContent = desktop || this.permission?.state === "granted" ? "Load system fonts" : "Allow now";
  }
  private permissionChanged = () => {
    if (this.permission?.state !== "granted") {
      this.localAvailable = false;
      if (this.source === "system") {
        this.revision++;
        this.source = "document"; this.face = this.embedded ?? bundledFont;
        if (!this.embedded) { this.weight = 400; this.italic = false; }
        this.changed();
      }
      fonts.clearLocal(); this.render();
    }
    this.accessMessage();
  };
  private loadLocal() {
    if (this.localLoading || this.disposed) return;
    this.localRequested = true;
    this.localLoading = true;
    this.get("sketch-local-fonts").setAttribute("disabled", "");
    void fonts.listLocal().then(() => {
      if (this.disposed) return;
      this.localAvailable = true; this.render(); this.accessMessage();
    }).catch(error => {
      if (this.disposed) return;
      this.localAvailable = false;
      const denied = error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name);
      this.accessMessage(denied ? "No permission to access local fonts. " : "System fonts could not be loaded. Import a font or try again. ");
      this.render();
    }).finally(() => { this.localLoading = false; this.get("sketch-local-fonts").removeAttribute("disabled"); });
  }
  activate() {
    // Request while the Text click still carries browser activation, even if
    // the Permissions API query has not settled or its descriptor is unsupported.
    if (fonts.supported && !this.localAvailable && this.permission?.state !== "denied" &&
        (this.permission?.state === "granted" || !this.localRequested) && navigator.userActivation?.isActive !== false) this.loadLocal();
    if (!this.hydrated) {
      this.hydrated = true;
      void this.scene.timeline.list().then(async entries => {
        for (const entry of entries) if (entry.type === "sketch") {
          const state = await (await this.scene.sketches.get(entry.id)).state();
          if (this.disposed) return;
          this.remember(state.texts.map(text => text.parameters));
        }
      }).catch(error => { if (!this.disposed) this.error(String(error)); });
    }
  }
  remember(parameters: TextParameters[]) {
    const count = fonts.all(this.scene, "document").length;
    for (const text of parameters) fonts.restore(this.scene, text, text.fontFamily);
    if (fonts.all(this.scene, "document").length !== count) this.render();
  }
  dispose() { this.disposed = true; this.revision++; this.permission?.removeEventListener("change", this.permissionChanged); }
  private get(id: string) { return this.panel.querySelector<HTMLElement>("#" + id)!; }
  private select(id: string) { return this.get(id) as HTMLSelectElement; }
  private button(group: string, value: string, icon: string, label: string, action: () => void) {
    const button = document.createElement("button");
    button.type = "button"; button.title = label; button.setAttribute("aria-label", label); button.dataset.value = value;
    button.innerHTML = icons[`../icons/${icon}.svg`]; button.querySelector("svg")?.setAttribute("aria-hidden", "true");
    button.onclick = action; this.get(group).append(button);
  }
  private familyFaces() { return fonts.all(this.scene, this.source).filter(face => face.family === this.face.family); }
  private weights(face: FontFaceInfo) { return face.weights ?? [face.weight]; }
  private render() {
    const familySelect = this.select("sketch-font-family");
    const groups = (["document", "system"] as const).flatMap(source => {
      if (source === "system" && !this.localAvailable) return [];
      const group = document.createElement("optgroup"); group.label = source === "document" ? "Document" : "System";
      const families = [...new Set(fonts.all(this.scene, source).map(face => face.family))].sort((a, b) => a.localeCompare(b));
      group.append(...families.map(name => new Option(name, JSON.stringify([source, name]))));
      return [group];
    });
    if (familySelect.innerHTML !== groups.map(group => group.outerHTML).join("")) familySelect.replaceChildren(...groups);
    familySelect.value = JSON.stringify([this.source, this.face.family]);
    const faces = this.familyFaces(), styled = faces.filter(face => face.italic === this.italic || face.variableItalic);
    const weights = [...new Set(styled.flatMap(face => this.weights(face)))].sort((a, b) => a - b);
    const dropdown = this.select("sketch-weight");
    dropdown.replaceChildren(...weights.map(value => new Option(`${weightNames[value] ?? "Weight"} (${value})`, String(value))));
    dropdown.value = String(this.weight);
    for (const button of this.get("sketch-font-styles").querySelectorAll<HTMLButtonElement>("button")) {
      const bold = button.dataset.value === "bold";
      button.setAttribute("aria-pressed", String(bold ? this.weight >= 700 : this.italic));
      button.disabled = bold ? !weights.includes(700) : !faces.some(face => face.italic !== this.italic || face.variableItalic);
    }
    for (const group of ["horizontal", "vertical"] as const) for (const button of this.get("sketch-" + group).querySelectorAll("button")) button.setAttribute("aria-pressed", String((button as HTMLElement).dataset.value === this[group]));
  }
  private choose(family: string) {
    const familyFaces = fonts.all(this.scene, this.source).filter(face => face.family === family);
    let candidates = familyFaces.filter(face => face.italic === this.italic || face.variableItalic);
    if (!candidates.length) candidates = familyFaces;
    candidates.sort((a, b) => Number(b.id === this.face.id) - Number(a.id === this.face.id));
    const exact = candidates.find(face => this.weights(face).includes(this.weight));
    const selected = exact ?? candidates.sort((a, b) => Math.abs(a.weight - this.weight) - Math.abs(b.weight - this.weight))[0];
    if (!selected) return;
    if (!selected.variableItalic) this.italic = selected.italic;
    if (!exact) this.weight = selected.weight;
    this.face = selected;
    const revision = ++this.revision;
    this.loading = fonts.load(this.scene, selected.id).then(data => {
      if (!this.disposed && revision === this.revision) {
        this.embedded = fonts.restore(this.scene, data, selected.family);
        this.render();
      }
    }).catch(error => { if (revision === this.revision) this.error(String(error)); });
    this.render(); this.changed();
  }
  restore(parameters: TextParameters) {
    this.revision++;
    this.source = "document";
    this.face = fonts.restore(this.scene, { fontBase64: parameters.fontBase64, fontIndex: parameters.fontIndex }, parameters.fontFamily);
    this.weight = parameters.weight ?? this.face.weight; this.italic = parameters.italic ?? this.face.italic;
    this.horizontal = parameters.horizontal ?? "left"; this.vertical = parameters.vertical ?? "baseline";
    (this.get("sketch-text") as HTMLTextAreaElement).value = parameters.text;
    this.render();
  }
  async parameters() {
    await this.loading;
    const face = this.face, text = (this.get("sketch-text") as HTMLTextAreaElement).value;
    const parameters = { text, fontFamily: face.family, weight: this.weight, italic: this.italic, horizontal: this.horizontal, vertical: this.vertical };
    const data = await fonts.load(this.scene, face.id);
    return { ...parameters, fontBase64: undefined, fontIndex: undefined, ...data };
  }
}
