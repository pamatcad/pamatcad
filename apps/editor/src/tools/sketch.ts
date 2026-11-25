import { Sketch, type Scene, type SketchState, type SketchProxy, type SketchEntityRef, type Primitive, type ConstraintKind, type DimensionKind, type SketchSupport, type GeometryData } from "@pamatcad/sdk";
import template from "./sketch.html?raw";
import { drawing, drawingClicks, variants, pointOf, distance, bearing, type DrawingFields, type SketchToolName } from "./sketch-geometry";
import { sketchDisplayDefaults, type SketchDisplayOptions, type SketchPick } from "../sketch-display";
import { type Hit, type Point, type ViewState, Viewport } from "../viewport";
import type { SelectionItem } from "../selection";
import { unitScale } from "../formula-input";
import type { ToolHandle } from "../tool-handles";
const icons = import.meta.glob<string>("../icons/*.svg", { query: "?url", import: "default", eager: true });
const toolIcons = import.meta.glob<string>("../icons/sketch-*.svg", { query: "?raw", import: "default", eager: true });
import { dimensionChoices, dimensionLayout, formatDimension, inferDimension } from "../sketch-dimensions";
import { constraintSelection } from "./sketch-constraints";
import { TextControls } from "./sketch-text";
const editing = new Set<SketchToolName>(["select", "dimension", "project", "offset", "rounding", "scale", "move", "split", "remove"]);
const title = (s: string) => s.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase());
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
type Hooks = {
  changed(pending: boolean): void;
  proxy(proxy: SketchProxy): void;
  visibility(choosingPlane: boolean): void;
  status(text: string): void;
};
export class SketchTool {
  sketch?: Sketch;
  state?: SketchState;
  proxy?: SketchProxy;
  readonly previousView: ViewState;
  readonly selected = new Set<string>();
  // "select" is the idle state; it has no ribbon command.
  tool: SketchToolName = "select";
  constraint?: ConstraintKind;
  variant = 0;
  private points: Point[] = [];
  private cursor?: Point;
  private options: SketchDisplayOptions = { ...sketchDisplayDefaults };
  private queue: Promise<unknown> = Promise.resolve();
  private pendingCount = 0;
  private blockingCount = 0;
  private handleVersion = 0;
  private previewQueued = false;
  private updateRunning = false;
  private regionsPending = false;
  private version = 0;
  private interaction = 0;
  private active = true;
  private lifetime?: AbortController;
  private popup?: HTMLElement;
  private textControls: TextControls;
  private editingText?: string | null; // null is a newly placed, uncommitted text draft.
  private dragText?: { id: string; cursor: Point; origin: Point };
  private dirty = new Set<string>();
  private numericFields = new Map<string, { text: string; source: string; formula?: boolean }>();
  private draftValid = false;
  private pivot: Point = [0, 0];
  private pickingPivot = false;
  private repairingProjection?: string;
  private changingSupport = false;
  private snapRefs = new Map<string, SketchEntityRef>();
  private dimensionKind?: DimensionKind;
  private dimensionPosition?: Point;
  private annotationDrag?: { id: string; start: Point; original: Point; position: Point; moved: boolean };
  private dragCircle = false;
  private dragEntity?: SketchEntityRef;
  private dragStart?: Point;
  private dragLine?: { cursor: Point; from: Point; to: Point };
  private dragExcluded = new Set<string>();
  private dragPosition?: Point;
  private dragMoved = false;
  private dragQueued?: { entity: SketchEntityRef; position: Parameters<Sketch["drag"]>[1] };
  private liveDimensions: HTMLElement;
  private creating = false;
  private constructionMode = false;
  private snapGeometry = true;
  private snapGrid = false;
  constructor(private panel: HTMLElement, private scene: Scene, private viewport: Viewport, private hooks: Hooks) {
    this.previousView = viewport.captureView();
    panel.innerHTML = template;
    this.liveDimensions = this.find(".sketch-live-dimensions");
    // All icon controls share the same accessible toggle and palette styling.
    const option = (group: string, label: string, icon: string, tip: string, pressed: boolean, action: (button: HTMLButtonElement) => void) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.tooltip = tip;
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", String(pressed));
      const glyph = document.createElement("span");
      glyph.className = "sketch-option-icon";
      glyph.style.setProperty("--icon", `url("${icons[`../icons/${icon}.svg`]}")`);
      glyph.setAttribute("aria-hidden", "true");
      button.append(glyph);
      button.onclick = () => action(button);
      this.get(group).append(button);
      return button;
    };
    for (const construction of [false, true]) {
      const button = option("sketch-construction", construction ? "Construction geometry" : "Normal geometry",
        construction ? "sketch-construction" : "sketch-line",
        construction ? "Construction geometry: guides excluded from closed profiles." : "Normal geometry: contributes to closed profiles for solid operations.",
        !construction, () => {
          const selected = this.geometry();
          const texts = this.state?.texts.filter(t => this.selected.has(t.id)) ?? [];
          if (this.editingText !== undefined) {
            this.constructionMode = construction;
            this.selectionChanged(); this.schedulePreview();
          } else if (texts.length) {
            void this.run(async () => { for (const text of texts) await this.sketch!.texts.update(text.id, { construction }); });
          } else if (selected.length) {
            void this.run(() => this.sketch!.construction(selected.map(e => e.reference), construction));
          } else {
            this.constructionMode = construction;
            this.selectionChanged();
            this.schedulePreview();
          }
        });
      button.dataset.construction = String(construction);
    }
    this.input("sketch-auto").onchange = () => this.run(() => this.sketch!.settings({ autoRecompute: this.input("sketch-auto").checked }));
    this.get("sketch-recompute").onclick = () => this.run(() => this.sketch!.recompute());
    for (const [value, label, icon] of [
      ["none", "No highlight", "sketch-highlight-none"], ["constrained", "Constrained geometry", "sketch-highlight-constrained"],
      ["partial", "Partially constrained geometry", "sketch-freedom-partial"], ["unconstrained", "Unconstrained geometry", "sketch-highlight-unconstrained"],
    ] as const) {
      const button = option("sketch-highlight", label, icon, value === "none" ? "Show normal geometry colors" : "Highlight " + label.toLowerCase(), this.options.highlight === value, () => {
        this.options.highlight = this.options.highlight === value ? "none" : value;
        for (const control of this.get("sketch-highlight").querySelectorAll("button")) control.setAttribute("aria-pressed", String(control.dataset.highlight === this.options.highlight));
        this.display();
      });
      button.dataset.highlight = value;
    }
    for (const [name, icon] of [["lines", "sketch-line"], ["points", "sketch-point"], ["constraints", "sketch-display-constraints"],
      ["dimensions", "sketch-display-dimensions"], ["construction", "sketch-display-construction"], ["projections", "sketch-display-projections"]] as const) {
      option("sketch-display-options", "Show " + name, icon, "Show or hide " + name, this.options[name], button => {
        this.options[name] = !this.options[name];
        button.setAttribute("aria-pressed", String(this.options[name]));
        this.display();
      });
    }
    option("sketch-snap-options", "Snap to geometry", "sketch-snap", "Snap to existing sketch points", this.snapGeometry, button => {
      this.snapGeometry = !this.snapGeometry;
      button.setAttribute("aria-pressed", String(this.snapGeometry));
    });
    option("sketch-snap-options", "Snap to grid", "sketch-grid", "Snap to the sketch grid", this.snapGrid, button => {
      this.snapGrid = !this.snapGrid;
      button.setAttribute("aria-pressed", String(this.snapGrid));
    });
    this.get("sketch-action").onclick = () => {
      if (this.creating) return;
      this.creating = true;
      void this.run(() => this.action()).finally(() => {
        this.creating = false;
        if (this.active) this.hooks.changed(this.pending);
      });
    };
    this.get("sketch-pivot").onclick = () => {
      this.pickingPivot = true;
      this.hooks.status("Pick the transform pivot in the sketch.");
    };
    this.get("sketch-repair-support").onclick = () => {
      this.changingSupport = true;
      this.supportChooser(true);
    };
    this.textControls = new TextControls(this.panel, this.scene,
      () => { if (this.active) this.schedulePreview(); }, message => { if (this.active) this.showError(message); });
    this.get("sketch-text-cancel").onclick = () => this.choose("select");
    this.get("sketch-text-done").onclick = () => {
      if (this.creating || !this.draftValid || this.pending) return;
      this.creating = true;
      void this.run(() => this.action()).finally(() => { this.creating = false; this.hooks.changed(this.pending); });
    };
    for (const field of this.panel.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("#sketch-config input, #sketch-config select, #sketch-config textarea, .sketch-live-dimensions input")) {
      if (field.type === "file" || ["sketch-font-family", "sketch-weight"].includes(field.id)) {
        continue;
      }
      let edit = 0;
      field.addEventListener("input", () => {
        edit++;
        this.numericFields.delete(field.id);
        this.dirty.add(field.id);
        this.schedulePreview();
        this.handles();
      });
      const dimension = field.dataset.dimension as "length" | "angle" | undefined;
      if (dimension && field instanceof HTMLInputElement) {
        this.setNumericField(field.id, Number(field.value));
        field.addEventListener("focus", () => {
          edit++;
          const stored = this.numericFields.get(field.id);
          if (stored?.formula && stored.text === field.value) field.value = stored.source;
        });
        field.addEventListener("blur", async () => {
          if (!this.dirty.has(field.id) && !this.numericFields.get(field.id)?.formula) return;
          const revision = ++edit, interaction = this.interaction;
          const text = field.value, source = this.fieldSource(field.id);
          try {
            const value = await this.number(field.id, dimension);
            if (revision !== edit || interaction !== this.interaction || document.activeElement === field || field.value !== text) return;
            this.setNumericField(field.id, value / unitScale[this.scene.units[dimension]]);
            this.numericFields.set(field.id, { text: field.value, source, formula: true });
          } catch {
            // Keep invalid expressions editable; the preview loop reports the error.
          }
        });
      }
    }
    this.choose("select");
    this.resume();
    this.supportChooser(true);
  }
  private get(id: string) {
    return (this.panel.querySelector<HTMLElement>(`#${id}`) ?? this.liveDimensions.querySelector<HTMLElement>(`#${id}`))!;
  }
  private find(selector: string) {
    return this.panel.querySelector<HTMLElement>(selector)!;
  }
  private input(id: string) {
    return this.get(id) as HTMLInputElement;
  }
  get pending() {
    return this.pendingCount > 0;
  }
  get blocking() {
    return this.creating || this.blockingCount > 0;
  }
  get ready() {
    return !!this.sketch && !this.pickingSupport && !this.pending && !this.creating && !this.points.length &&
      !this.dragEntity && !this.editingText && !this.annotationDrag && !this.dragQueued && !this.updateRunning && !this.previewQueued;
  }
  get pickingSupport() {
    return !this.sketch || this.changingSupport;
  }
  get filter() {
    return this.pickingSupport || this.tool === "project" ? "all" as const : "none" as const;
  }
  private geometry() {
    return this.state?.entities.filter(e => this.selected.has(e.reference.id)) ?? [];
  }
  private supportChooser(show: boolean) {
    this.get("sketch-support").hidden = !show;
    this.get("sketch-workspace").hidden = !this.sketch;
    this.hooks.visibility(show);
    this.updateCursor();
    this.hooks.changed(this.pending);
  }
  async start(existing?: Sketch, support?: SketchSupport) {
    if (existing) {
      this.sketch = existing;
      await existing.edit();
      this.viewport.sketching(true);
      await this.reload();
      this.supportChooser(false);
      this.choose("select");
      this.viewport.alignSketch();
    }
    else if (support) {
      await this.setSupport(support);
    }
  }
  private async setSupport(support: SketchSupport) {
    if (this.sketch) {
      await this.sketch.support.update(support);
    }
    else {
      this.sketch = await this.scene.sketches.create(support);
    }
    this.changingSupport = false;
    await this.reload();
    this.supportChooser(false);
    this.viewport.sketching(true);
    this.viewport.setSketchFrame(this.state!.frame);
    this.viewport.alignSketch();
    this.hooks.status("Sketch plane selected. Select geometry or choose a drawing tool.");
    this.schedulePreview();
  }
  private run(action: () => Promise<unknown>, reload = true, background = false) {
    this.pendingCount++;
    if (!background) this.blockingCount++;
    this.hooks.changed(true);
    this.showError("");
    const next = this.queue.then(action).then(() => reload ? this.reload(!background) : this.display()).catch(e => this.showError(errorText(e))).finally(() => {
      this.pendingCount--;
      if (!background) this.blockingCount--;
      if (this.active) {
        this.hooks.changed(this.pending);
      }
      this.flushUpdates();
    });
    this.queue = next;
    return next;
  }
  private showError(message: string) {
    this.get("sketch-error").textContent = message;
    this.get("sketch-error").hidden = !message;
    if (message) {
      this.hooks.status(message);
    }
  }
  private async reload(regions = true) {
    if (!this.sketch) {
      return;
    }
    const sketch = this.sketch, interaction = this.interaction;
    // Settle both reads before the next queued mutation can replace their source.
    const results = await Promise.allSettled([sketch.state(), sketch.getProxy({ regions })]);
    if (results[0].status === "rejected") throw results[0].reason;
    if (results[1].status === "rejected") throw results[1].reason;
    if (sketch !== this.sketch || interaction !== this.interaction || !this.active) {
      this.regionsPending = true;
      return;
    }
    const state = results[0].value, proxy = results[1].value;
    this.regionsPending = !regions;
    this.state = state;
    this.textControls.remember(state.texts.map(text => text.parameters));
    this.proxy = proxy;
    if (!this.active) {
      return;
    }
    this.input("sketch-auto").checked = state.autoRecompute;
    this.get("sketch-recompute").hidden = state.autoRecompute;
    this.hooks.proxy(proxy);
    this.references();
    this.selectionChanged();
  }
  private display(state = this.state, proxy = this.proxy, hover?: string) {
    if (state && proxy && this.active) {
      if (this.annotationDrag) {
        const drag = this.annotationDrag;
        state = { ...state, dimensions: state.dimensions.map(d => d.id === drag.id ? { ...d, parameters: { ...d.parameters, annotation: { position: drag.position } } } : d) };
      }
      const candidate = this.tool === "dimension" ? inferDimension(state, this.selected, this.dimensionPosition, this.dimensionKind) : undefined;
      if (candidate) {
        const unit = this.scene.units[candidate.kind === "angle" ? "angle" : "length"];
        state = { ...state, dimensions: [...state.dimensions, { id: "dimension-preview", kind: candidate.kind, parameters: candidate.parameters, computed: { value: candidate.value / unitScale[unit], unit }, dependencies: [] }] };
      }
      this.viewport.showSketch(state, proxy, this.selected, this.options, hover);
    }
  }
  private selectionChanged() {
    if (!this.state) {
      return;
    }
    const status = this.state.status;
    const selected = this.geometry();
    const selectedTexts = this.state.texts.filter(text => this.selected.has(text.id));
    const freedom = selected.length === 1 ? status.entities.find(e => e.entity.id === selected[0].reference.id) : undefined;
    this.get("sketch-status").textContent = freedom ? `${title(selected[0].geometry.type)} · ${freedom.degreesOfFreedom} DOF` : `${status.state} · ${status.degreesOfFreedom} sketch DOF`;
    if (selectedTexts.length) this.get("sketch-status").textContent = selectedTexts.length === 1 ? "Text" : `${selectedTexts.length} text objects`;
    if (status.warnings.length) {
      this.get("sketch-status").textContent += " · " + status.warnings.join(" · ");
    }
    for (const button of this.get("sketch-construction").querySelectorAll("button")) {
      const construction = button.dataset.construction === "true";
      button.disabled = selected.some(e => e.projected || this.state!.texts.some(t => Object.values(t.frame ?? {}).some(r => r.id === e.reference.id)) || this.state!.splines.some(s => s.envelope.some(r => r.id === e.reference.id) || s.fitPoints.some(p => [p.incoming, p.outgoing].some(r => r?.id === e.reference.id))));
      button.setAttribute("aria-pressed", String(this.editingText ? this.constructionMode === construction : selectedTexts.length ? selectedTexts.every(t => t.parameters.construction === construction) : selected.length ? selected.every(e => e.construction === construction) : this.constructionMode === construction));
    }
    this.handles();
    this.display();
    this.hooks.changed(this.pending);
  }
  private references() {
    const list = this.get("sketch-projections");
    list.replaceChildren();
    for (const p of this.state?.projections ?? []) {
      const row = document.createElement("div");
      row.className = "sketch-reference";
      const label = document.createElement("span");
      label.textContent = p.id + (p.warning ? " · " + p.warning : "");
      const repair = document.createElement("button");
      repair.type = "button";
      repair.textContent = "Update";
      repair.dataset.tooltip = "Update projection";
      repair.onclick = () => {
        this.repairingProjection = p.id;
        this.choose("project");
      };
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.dataset.tooltip = "Remove projection";
      remove.onclick = () => this.run(() => this.sketch!.remove([p.id]));
      row.append(label, repair, remove);
      list.append(row);
    }
  }
  choose(tool: SketchToolName, variant = 0) {
    const previous = this.tool;
    const discardText = this.editingText !== undefined && !this.creating;
    this.editingText = undefined;
    this.dragText = undefined;
    this.get("sketch-text-edit-actions").hidden = true;
    this.get("sketch-text-done").setAttribute("disabled", "");
    this.dragEntity = undefined;
    this.dragLine = undefined;
    this.dragQueued = undefined;
    this.annotationDrag = undefined;
    this.dimensionPosition = undefined;
    this.dimensionKind = undefined;
    this.tool = tool;
    this.constraint = undefined;
    this.variant = variant;
    this.viewport.pickVertices = tool === "project";
    this.points = [];
    this.cursor = undefined;
    this.snapRefs.clear();
    this.dirty.clear();
    this.draftValid = false;
    this.pickingPivot = false;
    this.version++;
    this.interaction++;
    this.previewQueued = false;
    this.popup?.remove();
    this.get("sketch-config").hidden = tool === "select";
    this.get("sketch-tool-title").textContent = title(tool);
    this.get("sketch-tool-icon").innerHTML = toolIcons[`../icons/sketch-${tool}.svg`];
    this.get("sketch-tool-empty").hidden = !["point", "line", "spline", "dimension", "project", "remove"].includes(tool);
    this.get("sketch-tool-empty").textContent = tool === "line" ? "Enter to finish, Esc to exit" : tool === "spline" ? "Enter to finish, Esc to exit. Click the first point to close." : tool === "remove" ? "Click a curve portion to remove it between intersections. Esc to exit." : "This tool has no configuration.";
    if (tool === "remove") this.selected.clear();
    const group = this.find(".sketch-variants");
    group.replaceChildren();
    group.hidden = variants[tool].length < 2;
    variants[tool].forEach((name, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.tooltip = name;
      b.setAttribute("aria-label", name);
      const icon = toolIcons[`../icons/sketch-${tool}-${i}.svg`];
      if (icon) {
        b.classList.add("sketch-variant-icon");
        b.innerHTML = icon;
        b.querySelector("svg")!.setAttribute("aria-hidden", "true");
      }
      b.append(document.createTextNode(name));
      b.setAttribute("aria-pressed", String(i === variant));
      b.onclick = () => this.choose(tool, i);
      group.append(b);
    });
    for (const id of ["sketch-radius", "sketch-angle"]) {
      const label = this.get(id + "-label");
      const inPanel = tool === "rounding" && id === "sketch-radius" || tool === "move" && id === "sketch-angle";
      label.hidden = !inPanel;
      (inPanel ? label : this.liveDimensions).append(this.input(id));
    }
    this.input("width").setAttribute("aria-label", tool === "line" ? "Length" : "Width");
    for (const row of [...this.panel.querySelectorAll<HTMLElement>("[data-tools]"), ...this.liveDimensions.querySelectorAll<HTMLElement>("[data-tools]")]) {
      row.hidden = !row.dataset.tools!.split(" ").includes(tool);
    }
    this.get("sketch-offset2-row").hidden = tool !== "offset" || variant !== 2;
    this.input("sketch-radius").hidden = !["circle", "arc", "slot", "rounding"].includes(tool) || tool === "circle" && variant === 4 || tool === "arc" && variant === 1;
    this.input("sketch-angle").hidden = !(tool === "arc" && variant === 0 || tool === "move");
    const action = this.get("sketch-action");
    action.hidden = !["offset", "split", "rounding", "scale", "move"].includes(tool);
    action.removeAttribute("disabled");
    action.textContent = action.hidden ? "" : "Apply " + tool;
    action.dataset.tooltip = action.textContent;
    if (tool === "move" && previous !== "move" || tool === "arc") this.setNumericField("sketch-angle", 0);
    if (tool === "slot") this.setNumericField("sketch-radius", Math.max(1e-6, 2 * this.viewport.pixelLength) / unitScale[this.scene.units.length]);
    if (tool === "dimension") this.hooks.status("Select geometry, then click to place the dimension. Right-click for alternate measurements.");
    this.updateDimensions();
    if (this.proxy) this.hooks.proxy(this.proxy);
    this.display();
    this.handles();
    this.updateCursor();
    this.hooks.changed(this.pending);
    if (discardText) void this.run(() => this.scene.discardPreview(), false, true);
    if (tool === "text") this.textControls.activate();
    this.flushUpdates();
  }
  private updateCursor() {
    const symbol = !this.active || this.pickingSupport ? undefined : this.constraint ? "constraint-" + this.constraint : this.tool === "select" ? undefined : this.tool;
    this.viewport.setSketchCursor(symbol, !editing.has(this.tool) && this.editingText === undefined);
  }
  constraintState(kind: ConstraintKind) {
    // Annotation selections are not constraint operands.
    const entities = this.geometry();
    return entities.length !== this.selected.size ? "invalid" : constraintSelection(kind, entities);
  }
  chooseConstraint(kind: ConstraintKind) {
    if (this.constraint === kind) {
      this.selected.clear();
      this.choose("select");
      this.selectionChanged();
      return;
    }
    if (this.constraintState(kind) === "invalid") return;
    this.choose("select");
    this.constraint = kind;
    this.updateCursor();
    this.selectionChanged();
    if (this.constraintState(kind) === "ready") void this.addConstraint(kind);
  }
  escape() {
    if (this.popup?.isConnected) {
      this.popup.remove();
      if (this.tool === "dimension") this.choose("select");
      else this.updateDimensions();
      document.getElementById("model-canvas")!.focus();
      return;
    }
    if (this.creating) {
      void this.queue.then(() => this.choose("select"));
      return;
    }
    const discardLine = ["line", "spline"].includes(this.tool) && this.points.length > 0;
    if (this.tool === "select") this.selected.clear();
    this.repairingProjection = undefined;
    this.choose("select");
    if (discardLine) void this.run(() => this.scene.discardPreview(), false, true);
    this.selectionChanged();
    document.getElementById("model-canvas")!.focus();
  }
  private updateDimensions(primitive?: Primitive) {
    if (this.popup instanceof HTMLInputElement && this.popup.isConnected) return;
    if (this.tool === "circle" && [1, 2].includes(this.variant)) this.input("sketch-radius").hidden = this.points.length < 2;
    const visible = this.active && !editing.has(this.tool) && this.points.length > 0;
    this.liveDimensions.hidden = !visible;
    if (!visible || !this.state) {
      this.viewport.setSketchInputs();
      return;
    }
    const a = this.points[0], b = this.cursor ?? this.points.at(-1)!;
    const positions: Record<string, Point> = {
      width: [(a[0] + b[0]) / 2, a[1]], height: [b[0], (a[1] + b[1]) / 2],
      "sketch-radius": [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], "sketch-angle": a,
    };
    if (primitive?.type === "rectangle") {
      const p = primitive.parameters, angle = Number(p.angle) * Math.PI / 180;
      const factor = p.centered ? 2 : 1;
      const w = (p.to[0] - p.from[0]) * factor, h = (p.to[1] - p.from[1]) * factor;
      const center = p.centered ? p.from : [p.from[0] + (w * Math.cos(angle) - h * Math.sin(angle)) / 2, p.from[1] + (w * Math.sin(angle) + h * Math.cos(angle)) / 2];
      positions.width = [center[0] + h * Math.sin(angle) / 2, center[1] - h * Math.cos(angle) / 2];
      positions.height = [center[0] + w * Math.cos(angle) / 2, center[1] + w * Math.sin(angle) / 2];
    } else if (primitive?.type === "ellipse") {
      const p = primitive.parameters;
      const angle = this.variant === 2 && this.points[1] ? bearing(this.points[0], this.points[1]) : 0;
      const widthIsMajor = Math.abs(Math.cos((p.angle ?? 0) * Math.PI / 180 - angle)) > 0.5;
      const w = Number(widthIsMajor ? p.major : p.minor), h = Number(widthIsMajor ? p.minor : p.major);
      positions.width = [p.center[0] + h * Math.sin(angle), p.center[1] - h * Math.cos(angle)];
      positions.height = [p.center[0] + w * Math.cos(angle), p.center[1] + w * Math.sin(angle)];
      if (!this.dirty.has("width")) this.setNumericField("width", 2 * w / unitScale[this.scene.units.length]);
      if (!this.dirty.has("height")) this.setNumericField("height", 2 * h / unitScale[this.scene.units.length]);
    } else if (primitive?.type === "circle") {
      positions["sketch-radius"] = primitive.parameters.center;
      if (!this.dirty.has("sketch-radius")) this.setNumericField("sketch-radius", Number(primitive.parameters.diameter) / 2 / unitScale[this.scene.units.length]);
    } else if (primitive?.type === "line") {
      const p = primitive.parameters;
      positions.width = [(p.from[0] + p.to[0]) / 2, (p.from[1] + p.to[1]) / 2];
    }
    const frame = this.state.frame, offset = this.viewport.pixelLength * 24;
    this.viewport.setSketchInputs([...this.liveDimensions.querySelectorAll<HTMLInputElement>("input")].filter(input => !input.hidden).map(element => {
      const p = positions[element.id];
      return { element, position: frame.origin.map((v, i) => v + frame.u[i] * p[0] + frame.v[i] * (p[1] + offset)) as [number, number, number] };
    }));
  }
  private snapped(point: Point, excluded = new Set<string>()): Point {
    let result: Point = [...point];
    if (this.tool === "spline" && this.points.length >= 3 && distance(point, this.points[0]) < this.viewport.pixelLength * 8) return [...this.points[0]];
    if (this.snapGrid) {
      result = result.map(v => Math.round(v)) as Point;
    }
    if (this.snapGeometry && this.state) {
      const limit = this.viewport.pixelLength * 8;
      const nearest = this.state.entities.filter(e => e.geometry.type === "point" && !excluded.has(e.reference.id)).map(e => ({ e, p: pointOf(this.state!, e.reference.id) })).filter(({ p }) => distance(p, point) < limit).sort((a, b) => distance(a.p, point) - distance(b.p, point))[0];
      if (nearest) {
        result = nearest.p;
        this.snapRefs.set(result.join(","), nearest.e.reference);
      }
    }
    return result;
  }
  private queueDrag(position: Point) {
    if (!this.dragEntity) return;
    const target = this.snapped(position, this.dragExcluded);
    if (this.dragPosition && distance(this.dragPosition, target) < 1e-12) return;
    this.dragPosition = target;
    const line = this.dragLine;
    const translated = (point: Point): Point => [point[0] + target[0] - line!.cursor[0], point[1] + target[1] - line!.cursor[1]];
    this.dragQueued = { entity: this.dragEntity, position: this.dragText ? [this.dragText.origin[0] + target[0] - this.dragText.cursor[0], this.dragText.origin[1] + target[1] - this.dragText.cursor[1]] : line ? { from: translated(line.from), to: translated(line.to) } : this.dragCircle ? { position: target } : target };
    this.flushUpdates();
  }
  private flushUpdates() {
    if (this.updateRunning || this.pending || !this.active || this.creating) return;
    if (!this.dragQueued && !this.previewQueued) {
      if (this.regionsPending && !this.dragEntity && !this.points.length && !this.editingText) {
        this.regionsPending = false;
        void this.run(() => this.reload(), false, true);
      }
      return;
    }
    const request = this.dragQueued;
    this.dragQueued = undefined;
    this.previewQueued = false;
    this.updateRunning = true;
    if (request) this.regionsPending = true;
    const update = request ? this.run(() => this.state?.texts.some(t => t.id === request.entity.id)
      ? this.sketch!.texts.update(request.entity.id, { origin: request.position as Point })
      : this.sketch!.drag(request.entity, request.position), true, true) : this.preview();
    void update.finally(() => {
      this.updateRunning = false;
      this.flushUpdates();
      if (this.active && !this.updateRunning && !this.pending) this.hooks.changed(false);
    });
  }
  click(hit: Hit) {
    if (this.creating || this.editingText !== undefined) return;
    if (this.pending && editing.has(this.tool) && !this.constraint) {
      return;
    }
    if (this.constraint && !this.pickingSupport) {
      const kind = this.constraint, entities = this.geometry();
      const picks = hit.picks.filter(p => p.kind === "geometry");
      const pick = picks.find(p => this.selected.has(p.id) || this.state?.entities.some(entity =>
        entity.reference.id === p.id && constraintSelection(kind, [...entities, entity]) !== "invalid"));
      if (pick) {
        if (this.selected.has(pick.id)) this.selected.delete(pick.id);
        else this.selected.add(pick.id);
        this.selectionChanged();
        if (this.constraintState(kind) === "ready") void this.addConstraint(kind);
      } else if (!hit.picks.length) {
        this.selected.clear();
        this.selectionChanged();
      } else this.hooks.status("Select compatible geometry for " + title(kind).toLowerCase() + ".");
      return;
    }
    if (this.pickingSupport) {
      const item = hit.item;
      if (item?.kind === "plane") {
        const plane = Object.values(this.scene.construction.builtin.planes).find(p => p.id === item.id);
        if (plane) {
          this.run(() => this.setSupport(plane));
        }
      }
      else if (item?.kind === "face") {
        this.run(() => this.setSupport(item.ref));
      }
      return;
    }
    if (this.tool === "remove") {
      const pick = hit.picks.find(p => p.kind === "geometry" && this.state?.entities.some(e =>
        e.reference.id === p.id && e.geometry.type !== "point"));
      const entity = this.state?.entities.find(e => e.reference.id === pick?.id);
      if (entity && hit.point && this.sketch) {
        const position = hit.point;
        void this.run(async () => {
          await this.sketch!.modifyCurves([entity.reference], { type: "remove", position });
          this.selected.clear();
          this.hooks.status("Curve portion removed. Click another curve or press Esc to exit.");
        });
      }
      return;
    }
    if (this.tool === "project") {
      const item = hit.item;
      if (item?.kind === "face" || item?.kind === "edge" || item?.kind === "vertex") {
        this.run(async () => {
          const source = item.kind === "face" ? { type: "face" as const, reference: item.ref } : item.kind === "edge" ? { type: "edge" as const, reference: item.ref } : { type: "vertex" as const, reference: item.ref };
          if (this.repairingProjection) {
            await this.sketch!.projections.update(this.repairingProjection, source);
          }
          else {
            await this.sketch!.projections.add(source);
          }
          this.repairingProjection = undefined;
        });
      }
      return;
    }
    if (this.pickingPivot && hit.point) {
      this.pivot = hit.point;
      this.pickingPivot = false;
      this.handles();
      return;
    }
    if (this.tool === "dimension") {
      if (this.popup?.isConnected) return;
      const pick = hit.picks.find(p => p.kind === "geometry");
      if (pick) {
        if (this.selected.size >= 2 && !this.selected.has(pick.id)) this.selected.clear();
        this.dimensionKind = undefined;
        this.dimensionPosition = undefined;
        this.pick(pick, true);
      } else if (hit.point && this.state) {
        const candidate = inferDimension(this.state, this.selected, hit.point, this.dimensionKind);
        if (candidate) {
          this.dimensionPosition = hit.point;
          this.display();
          const unit = this.scene.units[candidate.kind === "angle" ? "angle" : "length"];
          this.dimensionFormula(dimensionLayout(this.state, candidate)!.label, `${candidate.value / unitScale[unit]} ${unit}`, async value => {
            await this.sketch!.dimensions.add(candidate.kind, { ...candidate.parameters, value });
            this.selected.clear();
            this.choose("dimension");
          });
        } else this.hooks.status("Select a line, circle, arc, ellipse, two points, two lines, or a point and a line.");
      }
      return;
    }
    if (this.tool === "circle" && this.variant >= 3) {
      const count = this.variant === 3 ? 2 : 3;
      const pick = hit.picks.find(p => p.kind === "geometry" && this.state?.entities.some(e => e.reference.id === p.id && ["line", "circle", "arc"].includes(e.geometry.type)));
      if (pick && (this.selected.size < count || this.selected.has(pick.id))) {
        this.pick(pick, true);
        if (this.selected.size === count && hit.point) { this.points = [hit.point]; this.updateDimensions(); this.schedulePreview(); }
        else { this.points = []; this.updateDimensions(); }
        return;
      }
      if (this.geometry().length !== count) { this.hooks.status(`Select ${count} lines, circles or arcs.`); return; }
      this.points = [];
    }
    if (editing.has(this.tool)) {
      this.pick(hit.picks[0], hit.additive);
      return;
    }
    if (!hit.point) {
      return;
    }
    const count = drawingClicks(this.tool, this.variant);
    // A rejected final click remains editable without restarting the construction.
    if (["arc", "slot", "circle", "ellipse", "line"].includes(this.tool) && this.points.length >= count) this.points.length = count - 1;
    this.points.push(this.snapped(hit.point));
    this.cursor = undefined;
    if (this.tool === "slot" && this.points.length === 2 && !this.dirty.has("sketch-radius")) {
      const radius = Math.max(1e-6, Math.min(2 * this.viewport.pixelLength, distance(this.points[0], this.points[1]) / 100));
      this.setNumericField("sketch-radius", radius / unitScale[this.scene.units.length]);
    }
    if (this.tool === "circle" && [1, 2].includes(this.variant) && this.points.length === 2 && !this.dirty.has("sketch-radius")) this.setNumericField("sketch-radius", distance(this.points[0], this.points[1]) / 2 / unitScale[this.scene.units.length]);
    if (this.tool === "ellipse" && this.variant === 2 && this.points.length === 2 && !this.dirty.has("height")) this.setNumericField("height", Math.max(4 * this.viewport.pixelLength, distance(this.points[0], this.points[1]) / 5) / unitScale[this.scene.units.length]);
    this.updateDimensions();
    if (this.tool === "text") {
      this.editingText = null;
      this.selected.clear();
      this.get("sketch-text-edit-actions").hidden = false;
      this.updateCursor(); this.selectionChanged(); this.schedulePreview();
      (this.get("sketch-text") as HTMLTextAreaElement).focus();
      return;
    }
    const splineEnd = this.tool === "spline" && this.points.length > 1 && (this.points.length > 3 && distance(this.points[0], this.points.at(-1)!) < 1e-7 || this.splineEndpoint(this.snapRefs.get(this.points.at(-1)!.join(","))?.id));
    if (this.tool !== "spline" && this.points.length >= count || splineEnd) {
      this.creating = true;
      void this.run(() => this.create()).finally(() => {
        this.creating = false;
        if (this.active) this.hooks.changed(this.pending);
      });
    }
    else {
      this.schedulePreview();
    }
  }
  move(point: Point | null) {
    if (this.tool === "circle" && this.variant >= 3) {
      if (point && !this.creating && this.geometry().length === (this.variant === 3 ? 2 : 3)) {
        this.points = [point]; this.cursor = undefined; this.updateDimensions(); this.schedulePreview();
      }
      return;
    }
    if (point && this.tool === "dimension" && !this.popup?.isConnected) {
      this.dimensionPosition = point;
      this.display();
      return;
    }
    if (!point || !this.sketch || editing.has(this.tool) || this.creating || this.editingText !== undefined) {
      return;
    }
    const count = drawingClicks(this.tool, this.variant);
    if (["arc", "slot", "circle", "ellipse", "line"].includes(this.tool) && this.points.length >= count) this.points.length = count - 1;
    this.cursor = this.snapped(point);
    const scale = unitScale[this.scene.units.length];
    const update = (id: string, value: number) => {
      if (!this.dirty.has(id)) {
        this.setNumericField(id, value);
      }
    };
    if (this.points.length) {
      const a = this.points[0], b = this.cursor;
      const factor = this.tool === "rectangle" && this.variant === 2 || this.tool === "ellipse" && this.variant === 0 ? 2 : 1;
      if (this.tool === "rectangle" && this.variant === 1) {
        update("width", distance(a, this.points[1] ?? b) / scale);
        if (this.points[1]) {
          const edge = this.points[1], angle = Math.atan2(edge[1] - a[1], edge[0] - a[0]);
          update("height", Math.abs(-(b[0] - edge[0]) * Math.sin(angle) + (b[1] - edge[1]) * Math.cos(angle)) / scale);
        }
      } else {
        update("width", (this.tool === "line" ? distance(a, b) : Math.abs(b[0] - a[0]) * factor) / scale);
        update("height", Math.abs(b[1] - a[1]) * factor / scale);
      }
      if (this.tool === "circle" && this.variant === 0 || this.tool === "arc" && this.variant === 0) {
        update("sketch-radius", distance(a, this.tool === "arc" ? this.points[1] ?? b : b) / scale);
        if (this.tool === "arc" && this.points[1]) {
          const angle = ((bearing(a, b) - bearing(a, this.points[1])) * 180 / Math.PI + 360) % 360;
          update("sketch-angle", angle / unitScale[this.scene.units.angle]);
        }
      }
      if (this.tool === "slot" && this.points[1]) {
        const end = this.points[1], length = distance(a, end);
        if (length > 1e-7) update("sketch-radius", Math.abs((end[0] - a[0]) * (b[1] - a[1]) - (end[1] - a[1]) * (b[0] - a[0])) / length / scale);
      }
      this.schedulePreview();
      this.updateDimensions();
    }
  }
  private editText(id: string) {
    if (this.editingText !== undefined) return;
    const text = this.state?.texts.find(t => t.id === id);
    if (!text) return;
    this.choose("text");
    this.editingText = id;
    this.selected.clear(); this.selected.add(id);
    this.textControls.restore(text.parameters);
    this.points = [[...text.parameters.origin]];
    this.constructionMode = text.parameters.construction ?? false;
    const formula = text.parameters.size;
    const source = typeof formula === "object" ? formula.expression : String(formula);
    if (typeof formula === "object") {
      this.setNumericField("sketch-size", formula.computed.value * unitScale[formula.computed.unit] / unitScale[this.scene.units.length]);
      this.numericFields.set("sketch-size", { text: this.input("sketch-size").value, source, formula: true });
    } else { this.input("sketch-size").value = source; }
    this.get("sketch-text-edit-actions").hidden = false;
    this.updateCursor(); this.selectionChanged();
    this.schedulePreview();
    (this.get("sketch-text") as HTMLTextAreaElement).focus();
  }
  private pick(pick?: SketchPick, additive = false) {
    if (!additive) {
      this.selected.clear();
    }
    if (pick) {
      if (additive && this.selected.has(pick.id)) {
        this.selected.delete(pick.id);
      }
      else {
        this.selected.add(pick.id);
      }
    }
    this.selectionChanged();
  }
  private setNumericField(id: string, value: number, suffix?: string) {
    const dimension = this.input(id).dataset.dimension as "length" | "angle" | undefined;
    suffix ??= dimension ? " " + this.scene.units[dimension] : "";
    const text = formatDimension(value) + suffix, source = String(value) + suffix;
    this.input(id).value = text;
    this.numericFields.set(id, { text, source });
  }
  private fieldSource(id: string) {
    const text = this.input(id).value, numeric = this.numericFields.get(id);
    return numeric?.text === text ? numeric.source : text;
  }
  private async number(id: string, dimension: "length" | "angle" | "scalar" = "length") {
    let source = this.fieldSource(id).trim();
    for (const d of this.state?.dimensions ?? []) {
      for (const name of [d.id, d.parameters.name].filter((v): v is string => !!v).sort((a, b) => b.length - a.length)) {
        source = source.replace(new RegExp(`(?<![\\w.])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "g"), `sketches[${this.sketch!.id}]dimension[${d.id}]`);
      }
    }
    const value = await this.scene.evaluateFormula(source, { expectedDimension: dimension });
    return value.computed.value * unitScale[value.computed.unit];
  }
  private async fields(): Promise<DrawingFields> {
    const active = (id: string) => !this.input(id).closest<HTMLElement>("[data-tools]")!.hidden;
    const field = async (id: string, fallback: number, dimension: "length" | "angle" | "scalar" = "length") => active(id) ? this.number(id, dimension) : fallback;
    const [width, height, radius, angle] = await Promise.all([field("width", 10), field("height", 10), field("sketch-radius", 5), field("sketch-angle", 90, "angle")]);
    return { width, height, radius, angle, radiusTyped: this.dirty.has("sketch-radius"), widthTyped: this.dirty.has("width"), heightTyped: this.dirty.has("height"), size: this.fieldSource("sketch-size"), ...await this.textControls.parameters() };
  }
  private async primitive(preview = false): Promise<Primitive> {
    const tool = this.tool, variant = this.variant, dirty = new Set(this.dirty);
    const entities = tool === "text" ? [] : this.geometry();
    const construction = this.constructionMode, state = this.state!;
    let points = [...this.points];
    if (!points.length) throw new Error("Pick a starting point in the sketch.");
    if (this.cursor && (preview || tool !== "spline" && points.length < drawingClicks(tool, variant))) {
      points.push(this.cursor);
    }
    if (tool === "circle" && [1, 2].includes(variant) && points.length < 2 || tool === "ellipse" && variant === 2 && (points.length < 2 || points.length < 3 && !preview && !dirty.has("height"))) throw new Error("Complete the construction points first.");
    if (tool === "arc" && (points.length < 2 || points.length < 3 && !(variant === 0 && dirty.has("sketch-angle"))) || tool === "slot" && (points.length < 2 || points.length < 3 && !preview && !dirty.has("sketch-radius"))) {
      throw new Error("Complete the construction points first.");
    }
    const f = await this.fields();
    if (tool === "line" && dirty.has("width")) {
      const a = points[0], b = points[1] ?? [a[0] + 1, a[1]], angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      points = [a, [a[0] + f.width * Math.cos(angle), a[1] + f.width * Math.sin(angle)]];
    }
    if ((tool === "rectangle" && variant !== 1 || tool === "ellipse" && variant < 2) && (dirty.has("width") || dirty.has("height"))) {
      const a = points[0], b = points[1] ?? [a[0] + f.width, a[1] + f.height];
      const factor = tool === "rectangle" && variant === 2 || tool === "ellipse" && variant === 0 ? 2 : 1;
      points = [a, [dirty.has("width") ? a[0] + (Math.sign(b[0] - a[0]) || 1) * f.width / factor : b[0], dirty.has("height") ? a[1] + (Math.sign(b[1] - a[1]) || 1) * f.height / factor : b[1]]];
    }
    if (tool === "rectangle" && variant === 1 && points[1]) {
      const a = points[0], b = points[1], angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      if (dirty.has("width")) points[1] = [a[0] + f.width * Math.cos(angle), a[1] + f.width * Math.sin(angle)];
      if (dirty.has("height")) {
        const c = points[2], side = c ? Math.sign(-(c[0] - b[0]) * Math.sin(angle) + (c[1] - b[1]) * Math.cos(angle)) || 1 : 1;
        points[2] = [points[1][0] - side * f.height * Math.sin(angle), points[1][1] + side * f.height * Math.cos(angle)];
      }
    }
    if (tool === "circle" && variant === 0 && dirty.has("sketch-radius")) {
      points = points.slice(0, 1);
    }
    if (tool === "arc" && variant === 0 && dirty.has("sketch-angle") || tool === "slot" && dirty.has("sketch-radius")) points = points.slice(0, 2);
    const primitive = drawing(tool, variant, points, f, construction, entities, state);
    if (primitive.type === "arc" && variant === 0 && dirty.has("sketch-radius")) primitive.parameters.radius = f.radius;
    if (primitive.type === "text" && this.editingText) primitive.parameters.guide = state.texts.find(t => t.id === this.editingText)?.parameters.guide;
    return primitive;
  }
  private constructionGuide() {
    if (!this.state || !this.proxy) return;
    const points = [...this.points, ...(this.cursor ? [this.cursor] : [])], frame = this.state.frame;
    const world = (p: Point) => frame.origin.map((v, i) => v + frame.u[i] * p[0] + frame.v[i] * p[1]) as [number, number, number];
    const entity = (id: string) => ({ sceneId: this.scene.id, sketchId: this.sketch!.id, id: `draft-${id}` });
    this.display(this.state, { ...this.proxy,
      points: [...this.proxy.points, ...points.map((p, i) => ({ entity: entity(String(i)), position: world(p), construction: true, projected: false }))],
      curves: [...this.proxy.curves, ...(points.length > 1 ? [{ entity: entity("axis"), points: points.map(world), construction: true, projected: false }] : [])],
    });
  }
  private async add(primitive: Primitive, preview = false) {
    // The discriminated primitive union is preserved over the transport.
    const add = this.sketch!.primitives.add as (kind: Primitive["type"], parameters: Primitive["parameters"], options: {
      preview: boolean;
    }) => Promise<GeometryData>;
    return add(primitive.type, primitive.parameters, { preview });
  }
  private schedulePreview() {
    this.version++;
    this.previewQueued = false;
    this.draftValid = false;
    this.get("sketch-text-done").setAttribute("disabled", "");
    this.hooks.changed(this.pending);
    if (!this.sketch || editing.has(this.tool) && !["offset", "rounding", "scale", "move"].includes(this.tool) || !editing.has(this.tool) && !this.points.length || !this.active) {
      return;
    }
    if (this.tool === "circle" && [1, 2].includes(this.variant) && (this.points.length < 2 || this.variant === 2 && !this.cursor && this.points.length < 3 && !this.dirty.has("sketch-radius")) || this.tool === "ellipse" && this.variant === 2 && this.points.length < 2 || this.tool === "slot" && this.points.length < 2 || this.tool === "arc" &&
        (this.points.length < 2 || !this.cursor && !(this.variant === 0 && this.dirty.has("sketch-angle")))) {
      this.constructionGuide();
      this.showError("");
      return;
    }
    if (this.tool !== "text" && !(this.tool === "circle" && this.variant >= 3) && !editing.has(this.tool) && this.points.length === 1 && !this.cursor && !this.dirty.size) return;
    this.previewQueued = true;
    this.flushUpdates();
  }
  private preview() {
    const version = this.version, interaction = this.interaction, tool = this.tool;
    this.pendingCount++;
    this.hooks.changed(true);
    this.queue = this.queue.then(async () => {
      if (interaction !== this.interaction || !this.active || this.creating) {
        return;
      }
      if (editing.has(tool)) {
        await this.action(true);
      }
      else {
        const primitive = await this.primitive(true);
        if (interaction !== this.interaction || !this.active || this.creating) return;
        if (this.editingText && primitive.type === "text") await this.sketch!.texts.update(this.editingText, { ...primitive.parameters, fontBase64: primitive.parameters.fontBase64 ?? null, fontIndex: primitive.parameters.fontIndex ?? null }, { preview: true });
        else await this.add(primitive, true);
        if (interaction === this.interaction && version === this.version && this.active && !this.creating) this.updateDimensions(primitive);
      }
      if (interaction !== this.interaction || !this.active || this.creating) return;
      // Both reads must settle before another update can replace the preview cache.
      const results = await Promise.allSettled([this.sketch!.state({ preview: true }), this.sketch!.getProxy({ preview: true, regions: false })]);
      if (results[0].status === "rejected") throw results[0].reason;
      if (results[1].status === "rejected") throw results[1].reason;
      const state = results[0].value, proxy = results[1].value;
      if (!editing.has(tool) && tool !== "text" && tool !== "spline") {
        const oldIds = new Set(this.state?.entities.map(e => e.reference.id));
        const created = state.entities.filter(e => !oldIds.has(e.reference.id));
        const measurements: {
          kind: DimensionKind;
          curve?: SketchEntityRef;
          line?: SketchEntityRef;
          value: number;
        }[] = [];
        for (const entity of created) {
          const g = entity.geometry;
          if (g.type === "line" && !entity.construction && tool !== "line" && tool !== "rectangle") {
            measurements.push({ kind: "length", line: entity.reference, value: distance(pointOf(state, g.from), pointOf(state, g.to)) });
          }
          if ((g.type === "circle" || g.type === "arc") && this.input("sketch-radius").hidden) {
            measurements.push({ kind: "radius", curve: entity.reference, value: g.radius });
          }
        }
        for (const [i, m] of measurements.entries()) {
          state.dimensions.push({ id: `preview-dimension-${i}`, kind: m.kind, parameters: { curve: m.curve, line: m.line, mode: "driven" }, computed: { value: m.value / unitScale[this.scene.units.length], unit: this.scene.units.length }, dependencies: [] });
        }
      }
      if (interaction === this.interaction && this.active && !this.creating) {
        this.hooks.proxy(proxy);
        this.display(state, proxy);
        const waitingForRadius = tool === "slot" && !this.cursor && this.points.length === 2 && !this.dirty.has("sketch-radius");
        this.draftValid = version === this.version && !waitingForRadius;
        if (tool === "text") this.get("sketch-text-done").toggleAttribute("disabled", !this.draftValid);
        if (editing.has(tool)) this.get("sketch-action").toggleAttribute("disabled", !this.draftValid);
        if (version === this.version) this.showError("");
      }
    }).catch(e => {
      if (interaction === this.interaction && version === this.version && this.active && !this.creating) {
        this.draftValid = false;
        this.showError(errorText(e));
      }
    }).finally(() => {
      this.pendingCount--;
      if (this.active) {
        this.hooks.changed(this.pending);
      }
    });
    return this.queue;
  }
  private async create(finishLine = false) {
    const version = ++this.version, tool = this.tool;
    this.interaction++;
    this.previewQueued = false;
    const primitive = await this.primitive();
    if (version !== this.version) return;
    const result = await this.add(primitive);
    if (primitive.type === "rectangle") {
      for (const [id, index] of [["width", 0], ["height", 1]] as const) {
        if (this.dirty.has(id)) {
          await this.sketch!.dimensions.add("length", { line: result.curves[index], value: this.fieldSource(id), mode: "driving" });
        }
      }
    }
    else if (["circle", "arc", "slot"].includes(primitive.type) && this.dirty.has("sketch-radius")) {
      await this.sketch!.dimensions.add("radius", { curve: result.curves[0], value: this.fieldSource("sketch-radius"), mode: "driving" });
    }
    if (primitive.type === "ellipse") {
      const p = primitive.parameters;
      const angle = this.variant === 2 ? bearing(this.points[0], this.points[1]) : 0;
      const widthIsMajor = Math.abs(Math.cos((p.angle ?? 0) * Math.PI / 180 - angle)) > 0.5;
      for (const [id, index] of [["width", widthIsMajor ? 1 : 2], ["height", widthIsMajor ? 2 : 1]] as const) {
        if (this.dirty.has(id)) {
          await this.sketch!.dimensions.add("length", { line: result.curves[index], mode: "driving", value: this.fieldSource(id) });
        }
      }
    }
    if (primitive.type === "arc" && this.variant === 0 && this.dirty.has("sketch-angle")) {
      await this.sketch!.dimensions.add("angle", { curve: result.curves[0], mode: "driving", value: this.fieldSource("sketch-angle") });
    }
    if (primitive.type === "line" && this.dirty.has("width")) {
      await this.sketch!.dimensions.add("length", { line: result.curves[0], mode: "driving", value: this.fieldSource("width") });
    }
    if (this.tool === "circle" && this.variant >= 3) {
      for (const entity of this.geometry()) {
        await this.sketch!.constraints.add("tangent", { curves: [entity.reference, result.curves[0]] });
      }
    }
    const state = await this.sketch!.state();
    for (const point of primitive.type === "text" ? [] : result.points) {
      const position = pointOf(state, point.id);
      const reference = [...this.snapRefs].find(([key]) => distance(key.split(",").map(Number) as Point, position) < 1e-7)?.[1];
      if (reference) {
        if (primitive.type === "spline" && !primitive.parameters.closed && [result.points[0].id, result.points.at(-1)!.id].includes(point.id) && this.splineEndpoint(reference.id)) {
          await this.sketch!.splines.join({ from: point, to: reference });
        } else if (reference.id !== point.id) await this.sketch!.constraints.add("coincident", { points: [reference, point] });
      }
    }
    if (primitive.type === "circle" && [1, 2].includes(this.variant) || primitive.type === "arc" && this.variant === 1) {
      for (const point of this.points.slice(0, this.dirty.has("sketch-radius") ? 2 : 3)) {
        const reference = this.snapRefs.get(point.join(","));
        if (!reference) continue;
        await this.sketch!.constraints.add("pointOnCurve", { points: [reference], curves: [result.curves[0]] });
      }
    }
    this.points = [];
    this.cursor = undefined;
    this.snapRefs.clear();
    this.dirty.clear();
    this.hooks.status(title(tool) + " added");
    if (tool === "circle" && this.variant >= 3) this.selected.clear();
    this.choose(tool, this.variant);
    if (primitive.type === "line" && !finishLine) {
      const end = result.points[1], position = pointOf(await this.sketch!.state(), end.id);
      this.points = [position];
      this.snapRefs.set(position.join(","), end);
      this.updateDimensions();
    }
  }
  addConstraint(kind: ConstraintKind) {
    if (this.constraintState(kind) !== "ready") return Promise.resolve();
    const entities = this.geometry(), interaction = this.interaction;
    const parameters = { points: entities.filter(e => e.geometry.type === "point").map(e => e.reference), curves: entities.filter(e => e.geometry.type !== "point").map(e => e.reference) };
    this.selected.clear();
    this.selectionChanged();
    return this.run(async () => {
      try {
        if (kind === "coincident" && parameters.points.length === 2 && parameters.points.every(p => this.splineEndpoint(p.id))) {
          await this.sketch!.splines.join({ from: parameters.points[0], to: parameters.points[1] });
        } else await this.sketch!.constraints.add(kind, parameters);
      } catch (error) {
        if (interaction === this.interaction && this.constraint === kind && !this.selected.size) {
          entities.forEach(e => this.selected.add(e.reference.id));
          this.selectionChanged();
        }
        throw error;
      }
    });
  }
  deleteSelected() {
    if (!this.selected.size || this.pending) return;
    return this.run(async () => {
      await this.sketch!.remove([...this.selected]);
      this.selected.clear();
    });
  }
  private splineEndpoint(id?: string) {
    if (!id || !this.state) return false;
    const curves = this.state.entities.filter(e => e.geometry.type === "spline" && e.geometry.points.includes(id) && this.state!.splines.some(s => s.curve.id === e.reference.id));
    return curves.length === 1 && curves[0].geometry.type === "spline" && !curves[0].geometry.closed && [curves[0].geometry.points[0], curves[0].geometry.points.at(-1)].includes(id);
  }
  private async action(preview = false) {
    if (this.editingText) {
      const id = this.editingText, primitive = await this.primitive();
      if (primitive.type !== "text") return;
      await this.sketch!.texts.update(id, { ...primitive.parameters, fontBase64: primitive.parameters.fontBase64 ?? null, fontIndex: primitive.parameters.fontIndex ?? null }, { preview });
      if (!preview) this.choose("select");
      return;
    }
    if (!editing.has(this.tool)) {
      return this.create();
    }
    const tool = this.tool, variant = this.variant;
    const entities = this.geometry(), curves = entities.filter(e => e.geometry.type !== "point").map(e => e.reference);
    if (this.tool === "split") {
      await this.sketch!.modifyCurves(curves, { type: "split" });
    }
    else if (this.tool === "rounding") {
      await this.sketch!.modifyCurves(curves, { type: "rounding", radius: this.fieldSource("sketch-radius") }, { preview });
    }
    else if (this.tool === "offset") {
      await this.sketch!.modifyCurves(curves, { type: "offset", distance1: this.fieldSource("sketch-offset"), ...(this.variant ? { distance2: this.fieldSource(this.variant === 1 ? "sketch-offset" : "sketch-offset2") } : {}) }, { preview });
    }
    else if (this.tool === "scale" || this.tool === "move") {
      await this.sketch!.transform({ preview, entities: entities.map(e => e.reference), pivot: this.pivot, copy: this.input("sketch-copy").checked, ...(this.tool === "scale" ? { scale: this.fieldSource("sketch-scale") } : { translation: [await this.number("sketch-move-x"), await this.number("sketch-move-y")] as Point, angle: this.fieldSource("sketch-angle") }) });
    }
    if (!preview) {
      this.selected.clear();
      this.choose(tool, variant);
    }
  }
  private async handles() {
    const version=++this.handleVersion;
    if (!this.active || !this.state || !this.geometry().length || !["move", "scale"].includes(this.tool)) {
      if (this.active) {
        this.viewport.setHandles();
      }
      return;
    }
    const frame = this.state.frame, origin = frame.origin.map((v, i) => v + frame.u[i] * this.pivot[0] + frame.v[i] * this.pivot[1]) as [
      number,
      number,
      number
    ];
    try {
      const items:ToolHandle[]=[];
      const fields=this.tool==="scale"?[["sketch-scale","Scale",frame.u,"length","scalar"] as const]:[
        ["sketch-move-x","Move X",frame.u,"length",this.scene.units.length] as const,
        ["sketch-move-y","Move Y",frame.v,"length",this.scene.units.length] as const,
        ["sketch-angle","Rotate",frame.u,"angle",this.scene.units.angle] as const,
      ];
      for(const [id,label,direction,kind,unit] of fields) {
        const numeric=await this.number(id,unit==="scalar"?"scalar":kind);
        items.push({id,label,kind,unit,origin,direction,tangent:frame.v,value:numeric,
          factor:this.tool==="scale"?10:1,min:this.tool==="scale"?1e-6:kind==="angle"?-360:undefined,max:kind==="angle"?360:undefined,
          change:value=>{
            this.setNumericField(id, value/unitScale[unit], unit==="scalar"?"":" "+unit);
            this.dirty.add(id);this.schedulePreview();
          },
        });
      }
      if(this.active&&version===this.handleVersion)this.viewport.setHandles(items);
    }catch{
      if(this.active&&version===this.handleVersion)this.viewport.setHandles();
    }
  }

  private menuAt(client: Point) {
    this.popup?.remove();
    this.updateDimensions();
    const menu = document.createElement("div");
    menu.className = "sketch-popup";
    menu.style.left = client[0] + "px";
    menu.style.top = client[1] + "px";
    document.body.append(menu);
    this.popup = menu;
    return menu;
  }
  private dimensionFormula(at: Point, formula: string, save: (value: string, changed: boolean) => Promise<void>, dimension = "dimension-preview") {
    this.popup?.remove();
    const value = document.createElement("input"), canvas = document.getElementById("model-canvas")!;
    value.className = "sketch-dimension-input";
    const initial = formatDimension(formula);
    value.value = initial;
    const frame = this.state!.frame;
    const position = frame.origin.map((v, i) => v + frame.u[i] * at[0] + frame.v[i] * at[1]) as [number, number, number];
    const resize = () => {
      value.style.width = Math.min(26, Math.max(12, value.value.length + 2)) + "ch";
      this.viewport.setSketchInputs([{ element: value, position, dimension }]);
    };
    value.oninput = resize;
    value.setAttribute("aria-label", "Dimension formula");
    value.autocomplete = "off";
    value.spellcheck = false;
    value.onkeydown = e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.escape(); return; }
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || this.pending || !value.value.trim()) return;
      const changed = value.value !== initial;
      void this.run(async () => {
        await save(changed ? value.value : formula, changed);
        value.remove();
        if (this.active) { this.updateDimensions(); canvas.focus(); }
      });
    };
    this.popup = value;
    this.liveDimensions.hidden = true;
    canvas.parentElement!.append(value);
    resize();
    value.focus(); value.select();
  }
  private editDimension(id: string, client: Point, context = false) {
    const d = this.state?.dimensions.find(d => d.id === id);
    if (!d) return;
    const formula = d.parameters.value;
    const source = typeof formula === "object" ? formula.expression : typeof formula === "number" ? `${formula} ${d.kind === "angle" ? "deg" : "mm"}` : formula ?? `${d.computed.value} ${d.computed.unit}`;
    if (!context) {
      if (d.parameters.mode === "driven") { this.hooks.status("This dimension measures the geometry. Right-click to make it driving."); return; }
      const layout = dimensionLayout(this.state!, d);
      if (layout) this.dimensionFormula(layout.label, source, async (value, changed) => { if (changed) await this.sketch!.dimensions.update(id, { value }); }, id);
      return;
    }
    const menu = this.menuAt(client);
    const rename = document.createElement("form"), name = document.createElement("input"), save = document.createElement("button");
    name.value = d.parameters.name ?? d.id; name.setAttribute("aria-label", "Dimension name");
    save.textContent = "Rename"; rename.append(name, save);
    rename.onsubmit = e => { e.preventDefault(); void this.run(async () => { await this.sketch!.dimensions.update(id, { name: name.value }); menu.remove(); }); };
    const mode = document.createElement("button");
    mode.textContent = d.parameters.mode === "driven" ? "Make driving" : "Make driven";
    mode.onclick = () => this.run(async () => {
      await this.sketch!.dimensions.update(id, { mode: d.parameters.mode === "driven" ? "driving" : "driven", ...(d.parameters.mode === "driven" ? { value: `${d.computed.value} ${d.computed.unit}` } : {}) });
      menu.remove();
    });
    menu.append(rename, mode);
  }
  private placeAnnotation(id: string, position: Point) {
    const original = this.state!.dimensions.find(d => d.id === id)!;
    this.state = { ...this.state!, dimensions: this.state!.dimensions.map(d => d.id === id ? { ...d, parameters: { ...d.parameters, annotation: { position } } } : d) };
    this.display();
    return this.run(async () => {
      try {
        const updated = await this.sketch!.dimensions.update(id, { annotation: { position } });
        if (this.state) this.state = { ...this.state, dimensions: this.state.dimensions.map(d => d.id === id ? updated : d) };
      } catch (error) {
        if (this.state) this.state = { ...this.state, dimensions: this.state.dimensions.map(d => d.id === id ? original : d) };
        this.display();
        throw error;
      }
    }, false);
  }
  suspend() {
    this.annotationDrag = undefined;
    this.dimensionPosition = undefined;
    this.viewport.pickVertices = false;
    this.active = false;
    this.updateCursor();
    this.dragEntity = undefined;
    this.dragLine = undefined;
    this.dragQueued = undefined;
    this.handleVersion++;
    this.version++;
    this.interaction++;
    this.previewQueued = false;
    this.lifetime?.abort();
    this.popup?.remove();
    this.liveDimensions.remove();
    this.viewport.setSketchInputs();
    this.viewport.setHandles();
  }
  resume() {
    this.viewport.pickVertices = this.tool === "project";
    this.active = true;
    this.lifetime?.abort();
    this.lifetime = new AbortController();
    const signal = this.lifetime.signal;
    const canvas = document.getElementById("model-canvas")!;
    canvas.tabIndex = 0;
    canvas.parentElement!.append(this.liveDimensions);
    this.updateDimensions();
    canvas.addEventListener("dblclick", e => {
      if (!this.sketch || this.pending) {
        return;
      }
      e.preventDefault();
      const picks = this.viewport.sketchPicks(e);
      const fitPoint = picks.find(p => p.kind === "geometry" && this.state?.splines.some(s => s.fitPoints.some(n => n.point.id === p.id)));
      if (fitPoint && this.state) {
        const node = this.state.splines.flatMap(s => s.fitPoints).find(p => p.point.id === fitPoint.id)!;
        void this.run(() => this.sketch!.splines.setHandleMode(node.point, node.mode === "aligned" ? "independent" : "aligned"));
        return;
      }
      if (picks[0]?.kind === "text") { this.editText(picks[0].id); return; }
      const frameText = picks[0]?.kind === "geometry" && this.state?.texts.find(t => Object.values(t.frame ?? {}).some(r => r.id === picks[0].id));
      if (frameText) { this.editText(frameText.id); return; }
      if (picks[0]?.kind === "dimension") {
        this.editDimension(picks[0].id, [e.clientX, e.clientY]);
        return;
      }
      if (picks.length < 2) {
        return;
      }
      const menu = this.menuAt([e.clientX, e.clientY]);
      for (const pick of picks) {
        const b = document.createElement("button");
        b.textContent = `${pick.kind} · ${pick.id}`;
        b.onpointerenter = () => this.display(this.state, this.proxy, pick.id);
        b.onpointerleave = () => this.display();
        b.onclick = () => {
          this.pick(pick);
          menu.remove();
        };
        menu.append(b);
      }
    }, { signal });
    canvas.addEventListener("contextmenu", e => {
      if (!this.sketch) {
        return;
      }
      const picks = this.viewport.sketchPicks(e);
      const textPick = picks.find(p => p.kind === "text") ?? this.state?.texts.find(t => Object.values(t.frame ?? {}).some(r => picks[0]?.kind === "geometry" && r.id === picks[0].id));
      if (textPick && !this.pending) {
        e.preventDefault();
        const menu = this.menuAt([e.clientX, e.clientY]);
        const edit = document.createElement("button"); edit.textContent = "Edit text";
        edit.onclick = () => { menu.remove(); this.editText(textPick.id); };
        const convert = document.createElement("button"); convert.textContent = "Convert to sketch geometry";
        convert.onclick = () => { menu.remove(); void this.run(async () => { await this.sketch!.texts.explode(textPick.id); this.selected.clear(); this.choose("select"); }); };
        menu.append(edit, convert); return;
      }
      if (this.tool === "dimension" && this.state) {
        e.preventDefault();
        const menu = this.menuAt([e.clientX, e.clientY]);
        for (const kind of dimensionChoices(this.state, this.selected)) {
          const button = document.createElement("button"); button.textContent = title(kind);
          button.onclick = () => { this.dimensionKind = kind; menu.remove(); this.display(); };
          menu.append(button);
        }
        return;
      }
      const pick = this.viewport.sketchPicks(e).find(p => p.kind === "dimension");
      if (pick) {
        e.preventDefault();
        this.editDimension(pick.id, [e.clientX, e.clientY], true);
      }
    }, { signal });
    document.addEventListener("keydown", e => {
      if (e.defaultPrevented || e.target instanceof Element && e.target.closest("dialog, .sketch-popup, .sketch-dimension-input")) {
        return;
      }
      if (e.key.toLowerCase() === "d" && !e.ctrlKey && !e.metaKey && !e.altKey && !this.pickingSupport && !(e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]"))) {
        e.preventDefault(); this.choose("dimension"); return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']"))) {
        if (this.selected.size && !this.pending && !this.pickingSupport) {
          e.preventDefault();
          this.deleteSelected();
        }
        return;
      }
      if (e.key === "Tab" && !editing.has(this.tool)) {
        const fields = [...this.liveDimensions.querySelectorAll<HTMLInputElement>("input"), ...this.panel.querySelectorAll<HTMLInputElement>("#sketch-config input")].filter(f => f.type !== "checkbox" && f.type !== "file" && !!f.getClientRects().length);
        if (fields.length && (e.target === canvas || e.target === document.body || e.target instanceof Element && !!e.target.closest("#sketch-ribbon") || fields.includes(e.target as HTMLInputElement))) {
          e.preventDefault();
          const i = fields.indexOf(e.target as HTMLInputElement);
          const next = fields[(i + (e.shiftKey ? -1 : 1) + fields.length) % fields.length];
          next.focus();
          next.select();
        }
      }
      const geometryInput = e.target instanceof HTMLInputElement && (this.get("sketch-config").contains(e.target) || this.liveDimensions.contains(e.target));
      const drawingOnCanvas = e.target === canvas && !editing.has(this.tool) && this.points.length > 0;
      if (e.key === "Enter" && (geometryInput || drawingOnCanvas)) {
        e.preventDefault();
        if (this.tool === "line") {
          if (e.repeat || this.creating) return;
          if (geometryInput && this.dirty.has("width")) {
            this.creating = true;
            void this.run(() => this.create(true)).finally(() => { this.creating = false; if (this.active) this.hooks.changed(this.pending); });
          } else { this.choose("line"); void this.run(() => this.scene.discardPreview(), false, true); }
          return;
        }
        if (this.tool !== "text" && !e.repeat && !this.creating && (editing.has(this.tool) || this.points.length)) {
          this.creating = true;
          void this.run(() => this.action()).finally(() => {
            this.creating = false;
            if (this.active) this.hooks.changed(this.pending);
          });
        }
      }
    }, { signal });
    document.addEventListener("pointerdown", e => {
      if (this.popup?.isConnected && !this.popup.contains(e.target as Node)) {
        this.popup.remove();
        if (this.popup instanceof HTMLInputElement) this.updateDimensions();
      }
    }, { signal });
    canvas.addEventListener("pointerdown", e => {
      if (e.button === 0) canvas.focus({ preventScroll: true });
      if (e.button !== 0 || this.tool !== "select" || this.constraint || this.pending) {
        return;
      }
      const pick = this.viewport.sketchPicks(e)[0];
      if (pick?.kind === "dimension" && this.state) {
        const dimension = this.state.dimensions.find(d => d.id === pick.id), cursor = this.viewport.point(e);
        const layout = dimension && dimensionLayout(this.state, dimension);
        if (layout && cursor) {
          e.preventDefault(); e.stopImmediatePropagation();
          this.annotationDrag = { id: pick.id, start: cursor, original: layout.label, position: layout.label, moved: false };
          canvas.setPointerCapture(e.pointerId);
          this.hooks.changed(this.pending);
        }
        return;
      }
      if (pick?.kind === "text" && this.state) {
        const text = this.state.texts.find(t => t.id === pick.id), cursor = this.viewport.point(e);
        if (!text || !cursor) return;
        e.preventDefault(); e.stopImmediatePropagation();
        this.dragText = { id: text.id, cursor, origin: text.frame ? [...pointOf(this.state, text.frame.center.id)] : [...text.parameters.origin] };
        this.dragEntity = text.frame?.center ?? { sceneId: this.scene.id, sketchId: this.sketch!.id, id: text.id };
        this.dragStart = [e.clientX, e.clientY]; this.dragPosition = cursor; this.dragMoved = false;
        this.dragExcluded = new Set([...text.geometry.points, ...text.geometry.curves, ...Object.values(text.frame ?? {})].map(r => r.id));
        canvas.setPointerCapture(e.pointerId); this.hooks.changed(this.pending); return;
      }
      const entity = pick?.kind === "geometry" ? this.state?.entities.find(entity => entity.reference.id === pick.id) : undefined;
      const frameOwner = entity && this.state?.texts.find(t => Object.values(t.frame ?? {}).some(r => r.id === entity.reference.id));
      if (frameOwner && entity.reference.id !== frameOwner.frame!.center.id) return;
      if (!entity || entity.projected || !["point", "line", "circle", "arc"].includes(entity.geometry.type)) {
        return;
      }
      const cursor = this.viewport.point(e);
      if (!cursor) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.dragEntity = entity.reference;
      this.dragStart = [e.clientX, e.clientY];
      this.dragMoved = false;
      const geometry = entity.geometry;
      this.dragCircle = geometry.type === "circle" || geometry.type === "arc";
      this.dragLine = geometry.type === "line" ? { cursor, from: [...pointOf(this.state!, geometry.from)], to: [...pointOf(this.state!, geometry.to)] } : undefined;
      this.dragPosition = geometry.type === "point" ? geometry.position : cursor;
      this.dragExcluded = new Set(geometry.type === "line" ? [geometry.from, geometry.to] : geometry.type === "arc" ? [geometry.center, geometry.from, geometry.to] : geometry.type === "circle" ? [geometry.center] : [entity.reference.id]);
      if (frameOwner) for (const ref of [...Object.values(frameOwner.frame!), ...frameOwner.geometry.points, ...frameOwner.geometry.curves]) this.dragExcluded.add(ref.id);
      // Ignore the moving endpoints and their coincident partners, keeping other snap targets.
      let previousSize = 0;
      while (previousSize !== this.dragExcluded.size) {
        previousSize = this.dragExcluded.size;
        for (const constraint of this.state!.constraints) {
          const points = constraint.parameters.points ?? [];
          if (constraint.kind === "coincident" && points.some(p => this.dragExcluded.has(p.id))) {
            for (const point of points) this.dragExcluded.add(point.id);
          }
        }
      }
      canvas.setPointerCapture(e.pointerId);
      this.hooks.changed(this.pending);
    }, { capture: true, signal });
    canvas.addEventListener("pointermove", e => {
      if (this.annotationDrag && e.buttons === 1) {
        e.stopImmediatePropagation();
        const cursor = this.viewport.point(e), drag = this.annotationDrag;
        if (cursor) {
          drag.position = [drag.original[0] + cursor[0] - drag.start[0], drag.original[1] + cursor[1] - drag.start[1]];
          drag.moved ||= distance(cursor, drag.start) > this.viewport.pixelLength;
          this.display();
        }
        return;
      }
      if (!this.dragEntity || e.buttons !== 1) {
        return;
      }
      e.stopImmediatePropagation();
      const point = this.viewport.point(e);
      if (point && this.dragStart && (this.dragMoved || distance(this.dragStart, [e.clientX, e.clientY]) > 0)) {
        this.dragMoved = true;
        this.queueDrag(point);
      }
    }, { capture: true, signal });
    canvas.addEventListener("pointerup", e => {
      if (this.annotationDrag && e.button === 0) {
        e.stopImmediatePropagation();
        const drag = this.annotationDrag, cursor = this.viewport.point(e);
        if (cursor) drag.position = [drag.original[0] + cursor[0] - drag.start[0], drag.original[1] + cursor[1] - drag.start[1]];
        this.annotationDrag = undefined;
        this.pick({ kind: "dimension", id: drag.id }, e.shiftKey);
        if (drag.moved) void this.placeAnnotation(drag.id, drag.position);
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        return;
      }
      if (!this.dragEntity || e.button !== 0) {
        return;
      }
      e.stopImmediatePropagation();
      const ref = this.dragEntity;
      let join: SketchEntityRef | undefined;
      if (this.dragMoved) {
        const point = this.viewport.point(e);
        if (point) {
          if (this.snapGeometry && this.splineEndpoint(ref.id)) join = this.state?.entities.find(entity => entity.geometry.type === "point" && entity.reference.id !== ref.id && this.splineEndpoint(entity.reference.id) && distance(entity.geometry.position, point) < this.viewport.pixelLength * 8)?.reference;
          if (join) this.dragQueued = undefined;
          else this.queueDrag(point);
        }
      } else {
        this.pick({ kind: this.dragText ? "text" : "geometry", id: this.dragText?.id ?? ref.id }, e.shiftKey);
      }
      this.dragEntity = undefined;
      this.dragText = undefined;
      this.dragLine = undefined;
      if (join) {
        const to = join;
        void this.run(async () => {
          await this.sketch!.splines.join({ from: ref, to });
          if (this.selected.delete(ref.id)) this.selected.add(to.id);
        });
      }
      this.hooks.changed(this.pending);
      this.flushUpdates();
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    }, { capture: true, signal });
    const clearDrag = () => {
      if (this.annotationDrag) { this.annotationDrag = undefined; this.display(); }
      // A normal release has already cleared dragEntity and must retain its queued target.
      if (this.dragEntity) this.dragQueued = undefined;
      this.dragEntity = undefined;
      this.dragText = undefined;
      this.dragLine = undefined;
      this.dragStart = undefined;
      this.hooks.changed(this.pending);
      this.flushUpdates();
    };
    canvas.addEventListener("pointercancel", clearDrag, { signal });
    canvas.addEventListener("lostpointercapture", clearDrag, { signal });
    if (this.state) {
      this.viewport.sketching(true);
      this.display();
      this.handles();
      if (this.dirty.size || this.points.length) {
        this.schedulePreview();
      }
    }
    this.updateCursor();
    this.flushUpdates();
  }
  async finish() {
    if (this.editingText !== undefined) throw new Error("Finish or cancel the text edit before finishing the sketch.");
    if (this.points.length) throw new Error("Complete or cancel the current geometry before finishing the sketch.");
    if (this.dragEntity || this.annotationDrag || this.dragQueued) throw new Error("Finish the current drag before finishing the sketch.");
    this.version++;
    this.interaction++;
    this.previewQueued = false;
    await this.queue;
    if (!this.sketch) {
      throw new Error("Choose a sketch plane first.");
    }
    if (["move", "scale", "offset", "rounding"].includes(this.tool) && this.dirty.size) {
      await this.action();
    }
    await this.sketch.complete();
    return this.sketch.id;
  }
  async cancel() {
    this.dragEntity = undefined;
    this.dragLine = undefined;
    this.dragQueued = undefined;
    this.version++;
    this.interaction++;
    this.previewQueued = false;
    await this.queue;
    if (this.sketch) {
      await this.sketch.cancel();
    }
  }
  close() {
    this.suspend();
    this.textControls.dispose();
    this.viewport.sketching(false);
    this.viewport.restoreView(this.previousView);
    this.hooks.visibility(false);
  }
}
