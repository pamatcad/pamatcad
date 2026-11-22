import type { FormulaDimension, FormulaUnit, Scene } from "@pamatcad/sdk";

export const unitScale: Record<FormulaUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, deg: 1, rad: 180 / Math.PI, scalar: 1 };

/** Values exchanged with viewport handles use millimetres and degrees. */
export class FormulaInput {
  value = 0;
  private version = 0;
  private error: HTMLElement;

  constructor(readonly input: HTMLInputElement, readonly dimension: FormulaDimension, private scene: Scene, changed: () => void) {
    input.autocomplete = "off";
    input.spellcheck = false;
    this.error = document.createElement("small");
    this.error.className = "field-error";
    this.error.id = input.id + "-error";
    this.error.setAttribute("aria-live", "polite");
    input.setAttribute("aria-describedby", this.error.id);
    input.parentElement!.append(this.error);
    input.oninput = () => { this.version++; this.setError(""); changed(); };
  }

  get unit() { return this.dimension === "scalar" ? "scalar" : this.scene.units[this.dimension]; }

  async evaluate(): Promise<number> {
    const version = ++this.version;
    try {
      if (!this.input.value.trim()) throw new Error("Enter a value.");
      const result = await this.scene.evaluateFormula(this.input.value, { expectedDimension: this.dimension });
      const value = result.computed.value * unitScale[result.computed.unit];
      if (version === this.version) { this.value = value; this.setError(""); }
      return value;
    } catch (error) {
      if (version === this.version) this.setError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  setFromHandle(value: number) {
    this.value = value;
    this.input.value = `${Number((value / unitScale[this.unit]).toPrecision(12))}${this.unit === "scalar" ? "" : " " + this.unit}`;
    this.input.dispatchEvent(new Event("input", { bubbles: true }));
    this.input.focus({ preventScroll: true });
    this.input.select();
  }

  private setError(message: string) {
    this.input.setCustomValidity(message);
    this.input.setAttribute("aria-invalid", String(!!message));
    this.error.textContent = message;
    this.error.hidden = !message;
  }
}

export function lengthStep(mmPerPixel: number, screenPixels: number, unit: FormulaUnit, value: number): number {
  const scale = unitScale[unit];
  const desired = mmPerPixel * screenPixels / 50 / scale;
  if (unit === "in" && Math.abs(value / scale) < 10) {
    return 2 ** Math.round(Math.log2(Math.max(desired, 1 / 1024))) * scale;
  }
  const power = 10 ** Math.floor(Math.log10(Math.max(desired, 1e-9)));
  const candidates = [1, 2, 2.5, 5, 10].map((n) => n * power);
  return candidates.reduce((best, n) => Math.abs(Math.log(n / desired)) < Math.abs(Math.log(best / desired)) ? n : best) * scale;
}
