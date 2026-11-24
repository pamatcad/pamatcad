import type { TextParameters } from "@pamatcad/sdk";
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
  constructor(private panel: HTMLElement, private changed: () => void, private error: (message: string) => void) {
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
    this.select("sketch-font-family").onchange = () => { this.weight = 400; this.italic = false; this.choose(this.select("sketch-font-family").value); };
    const help = this.get("sketch-font-help"), local = this.get("sketch-local-fonts");
    help.hidden = fonts.supported;
    help.title = unsupportedFonts;
    local.hidden = !fonts.supported;
    local.onclick = () => {
      local.setAttribute("disabled", "");
      void fonts.listLocal().then(() => { help.hidden = true; this.render(); }).catch(error => {
        help.hidden = false;
        help.title = error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name)
          ? "Access to installed fonts was denied or blocked. Allow local-font access in this browser's site permissions, then try again."
          : "Installed fonts could not be loaded. You can still use Roboto or import a font file.";
      }).finally(() => local.removeAttribute("disabled"));
    };
    (this.get("sketch-font") as HTMLInputElement).onchange = async () => {
      const file = (this.get("sketch-font") as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const imported = fonts.import(new Uint8Array(await file.arrayBuffer()));
        this.face = imported[0]; this.weight = this.face.weight; this.italic = this.face.italic;
        this.render(); this.changed();
      } catch (error) { this.error(String(error)); }
    };
    this.render();
    if (import.meta.env.MODE === "desktop") local.click();
  }
  private get(id: string) { return this.panel.querySelector<HTMLElement>("#" + id)!; }
  private select(id: string) { return this.get(id) as HTMLSelectElement; }
  private button(group: string, value: string, icon: string, label: string, action: () => void) {
    const button = document.createElement("button");
    button.type = "button"; button.title = label; button.setAttribute("aria-label", label); button.dataset.value = value;
    button.innerHTML = icons[`../icons/${icon}.svg`]; button.querySelector("svg")?.setAttribute("aria-hidden", "true");
    button.onclick = action; this.get(group).append(button);
  }
  private familyFaces() { return fonts.all().filter(face => face.family === this.face.family); }
  private weights(face: FontFaceInfo) { return face.weights ?? [face.weight]; }
  private render() {
    const families = [...new Set(fonts.all().map(face => face.family))].sort((a, b) => a.localeCompare(b));
    const familySelect = this.select("sketch-font-family");
    if (Array.from(familySelect.options, o => o.value).join("\n") !== families.join("\n")) familySelect.replaceChildren(...families.map(name => new Option(name, name)));
    familySelect.value = this.face.family;
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
    const candidates = fonts.all().filter(face => face.family === family && (face.italic === this.italic || face.variableItalic));
    candidates.sort((a, b) => Number(b.id === this.face.id) - Number(a.id === this.face.id));
    const exact = candidates.find(face => this.weights(face).includes(this.weight));
    const selected = exact ?? candidates.sort((a, b) => Math.abs(a.weight - this.weight) - Math.abs(b.weight - this.weight))[0];
    if (!selected) return;
    if (!exact) this.weight = selected.weight;
    this.face = selected;
    const revision = ++this.revision;
    this.loading = fonts.load(selected.id).then(() => {
      if (revision === this.revision) { this.render(); this.changed(); }
    }).catch(error => { if (revision === this.revision) this.error(String(error)); });
    this.render();
  }
  restore(parameters: TextParameters) {
    this.revision++;
    this.face = fonts.restore({ fontBase64: parameters.fontBase64, fontIndex: parameters.fontIndex }, parameters.fontFamily);
    this.weight = parameters.weight ?? this.face.weight; this.italic = parameters.italic ?? this.face.italic;
    this.horizontal = parameters.horizontal ?? "left"; this.vertical = parameters.vertical ?? "baseline";
    (this.get("sketch-text") as HTMLTextAreaElement).value = parameters.text;
    this.render();
  }
  async parameters() {
    await this.loading;
    return { text: (this.get("sketch-text") as HTMLTextAreaElement).value, fontBase64: undefined, fontIndex: undefined, ...await fonts.load(this.face.id), fontFamily: this.face.family, weight: this.weight, italic: this.italic, horizontal: this.horizontal, vertical: this.vertical };
  }
}
