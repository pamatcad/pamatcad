import { Sketch, type Scene, type SketchState, type SketchProxy, type SketchEntityRef, type Primitive, type ConstraintKind, type DimensionKind, type SketchSupport, type GeometryData } from "@pamatcad/sdk";
import template from "./sketch.html?raw";
import { drawing, variants, pointOf, distance, type DrawingFields, type SketchToolName } from "./sketch-geometry";
import { sketchDisplayDefaults, type SketchDisplayOptions, type SketchPick } from "../sketch-display";
import { type Hit, type Point, type ViewState, Viewport } from "../viewport";
import type { SelectionItem } from "../selection";
import { unitScale } from "../formula-input";
import type { ToolHandle } from "../tool-handles";
const dimensionKinds: DimensionKind[] = ["length", "distance", "horizontalDistance", "verticalDistance", "radius", "diameter", "majorRadius", "minorRadius", "angle"];
const editing = new Set<SketchToolName>(["select", "dimension", "project", "offset", "rounding", "scale", "move", "split"]);
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
  variant = 0;
  private points: Point[] = [];
  private cursor?: Point;
  private options: SketchDisplayOptions = { ...sketchDisplayDefaults };
  private queue: Promise<unknown> = Promise.resolve();
  private pendingCount = 0;
  private handleVersion = 0;
  private previewQueued = false;
  private updateRunning = false;
  private version = 0;
  private interaction = 0;
  private active = true;
  private lifetime?: AbortController;
  private popup?: HTMLElement;
  private fontBase64?: string;
  private dirty = new Set<string>();
  private draftValid = false;
  private pivot: Point = [0, 0];
  private pickingPivot = false;
  private repairingProjection?: string;
  private changingSupport = false;
  private snapRefs = new Map<string, SketchEntityRef>();
  private dragEntity?: SketchEntityRef;
  private dragStart?: Point;
  private dragLine?: { cursor: Point; from: Point; to: Point };
  private dragExcluded = new Set<string>();
  private dragPosition?: Point;
  private dragMoved = false;
  private dragQueued?: { entity: SketchEntityRef; position: Parameters<Sketch["drag"]>[1] };
  private liveDimensions: HTMLElement;
  private creating = false;
  constructor(private panel: HTMLElement, private scene: Scene, private viewport: Viewport, private hooks: Hooks) {
    this.previousView = viewport.captureView();
    panel.innerHTML = template;
    this.liveDimensions = this.find(".sketch-live-dimensions");
    const planes = this.get("sketch-planes");
    for (const [name, plane] of Object.entries(scene.construction.builtin.planes)) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = name.toUpperCase();
      b.onclick = () => this.run(() => this.setSupport(plane));
      planes.append(b);
    }
    this.input("sketch-name").onchange = () => {
      if (this.sketch) {
        this.run(() => this.sketch!.settings({ name: this.input("sketch-name").value }));
      }
    };
    this.input("sketch-auto").onchange = () => this.run(() => this.sketch!.settings({ autoRecompute: this.input("sketch-auto").checked }));
    this.get("sketch-recompute").onclick = () => this.run(() => this.sketch!.recompute());
    this.get("sketch-highlight").onchange = () => {
      this.options.highlight = this.selectValue("sketch-highlight") as SketchDisplayOptions["highlight"];
      this.display();
    };
    this.get("sketch-action").onclick = () => {
      if (this.creating) return;
      this.creating = true;
      void this.run(() => this.action()).finally(() => { this.creating = false; });
    };
    this.get("sketch-convert").onclick = () => this.run(() => this.sketch!.construction(this.geometry().map(e => e.reference), !this.geometry().every(e => e.construction)));
    this.get("sketch-pivot").onclick = () => {
      this.pickingPivot = true;
      this.hooks.status("Pick the transform pivot in the sketch.");
    };
    this.get("sketch-repair-support").onclick = () => {
      this.changingSupport = true;
      this.supportChooser(true);
    };
    this.input("sketch-font").onchange = () => this.run(async () => {
      const file = this.input("sketch-font").files?.[0];
      if (!file) {
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let data = "";
      for (let i = 0; i < bytes.length; i += 8192) {
        data += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      this.fontBase64 = btoa(data);
      this.schedulePreview();
    });
    for (const name of ["lines", "points", "constraints", "dimensions", "construction", "projections"] as const) {
      const label = document.createElement("label");
      label.className = "check";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.onchange = () => {
        this.options[name] = checkbox.checked;
        this.display();
      };
      label.append(checkbox, " " + title(name));
      this.get("sketch-display-options").append(label);
    }
    for (const field of this.panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>("#sketch-config input, #sketch-config select, .sketch-live-dimensions input")) {
      if (field.type === "file") {
        continue;
      }
      field.addEventListener("input", () => {
        this.dirty.add(field.id);
        this.schedulePreview();
        this.handles();
      });
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
  private selectValue(id: string) {
    return (this.get(id) as HTMLSelectElement).value;
  }
  get pending() {
    return this.pendingCount > 0;
  }
  get ready() {
    return !!this.sketch && !this.pending && (editing.has(this.tool) || !this.points.length || this.draftValid && (this.points.length > 1 || this.dirty.size > 0));
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
    this.input("sketch-name").value = this.state!.sketch.name ?? this.sketch.id;
    this.hooks.status("Sketch plane selected. Select geometry or choose a drawing tool.");
    this.schedulePreview();
  }
  private run(action: () => Promise<unknown>) {
    this.pendingCount++;
    this.hooks.changed(true);
    this.showError("");
    const next = this.queue.then(action).then(() => this.reload()).catch(e => this.showError(errorText(e))).finally(() => {
      this.pendingCount--;
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
  private async reload() {
    if (!this.sketch) {
      return;
    }
    const [state, proxy] = await Promise.all([this.sketch.state(), this.sketch.getProxy()]);
    this.state = state;
    this.proxy = proxy;
    if (!this.active) {
      return;
    }
    this.input("sketch-auto").checked = state.autoRecompute;
    if (document.activeElement !== this.input("sketch-name")) {
      this.input("sketch-name").value = state.sketch.name ?? state.sketch.id;
    }
    this.hooks.proxy(proxy);
    this.display();
    this.references();
    this.selectionChanged();
  }
  private display(state = this.state, proxy = this.proxy, hover?: string) {
    if (state && proxy && this.active) {
      this.viewport.showSketch(state, proxy, this.selected, this.options, hover);
    }
  }
  private selectionChanged() {
    if (!this.state) {
      return;
    }
    const status = this.state.status;
    const selected = this.geometry();
    const freedom = selected.length === 1 ? status.entities.find(e => e.entity.id === selected[0].reference.id) : undefined;
    this.get("sketch-status").textContent = freedom ? `${title(selected[0].geometry.type)} · ${freedom.degreesOfFreedom} DOF` : `${status.state} · ${status.degreesOfFreedom} sketch DOF`;
    if (status.warnings.length) {
      this.get("sketch-status").textContent += " · " + status.warnings.join(" · ");
    }
    this.get("sketch-convert").toggleAttribute("disabled", !selected.length || selected.some(e => e.projected));
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
      repair.onclick = () => {
        this.repairingProjection = p.id;
        this.choose("project");
      };
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.onclick = () => this.run(() => this.sketch!.remove([p.id]));
      row.append(label, repair, remove);
      list.append(row);
    }
  }
  choose(tool: SketchToolName, variant = 0) {
    this.dragEntity = undefined;
    this.dragLine = undefined;
    this.dragQueued = undefined;
    this.tool = tool;
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
    const group = this.find(".sketch-variants");
    group.replaceChildren();
    group.hidden = variants[tool].length < 2;
    variants[tool].forEach((name, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = name;
      b.setAttribute("aria-pressed", String(i === variant));
      b.onclick = () => this.choose(tool, i);
      group.append(b);
    });
    for (const id of ["sketch-radius", "sketch-angle"]) {
      const row = this.input(id).closest("label")!;
      // The two-tangent circle needs its radius before the single placement click.
      ((tool === "rounding" || tool === "circle" && variant === 3) && id === "sketch-radius" || tool === "move" && id === "sketch-angle" ? this.get("sketch-config") : this.liveDimensions).append(row);
    }
    this.input("width").previousElementSibling!.textContent = tool === "line" ? "Length" : "Width";
    for (const row of [...this.panel.querySelectorAll<HTMLElement>("[data-tools]"), ...this.liveDimensions.querySelectorAll<HTMLElement>("[data-tools]")]) {
      row.hidden = !row.dataset.tools!.split(" ").includes(tool);
    }
    this.get("sketch-offset2-row").hidden = tool !== "offset" || variant !== 2;
    this.input("sketch-radius").closest<HTMLElement>("label")!.hidden = !["circle", "arc", "slot", "rounding"].includes(tool) || tool === "circle" && [2, 4].includes(variant) || tool === "arc" && variant === 1;
    this.input("sketch-angle").closest<HTMLElement>("label")!.hidden = !(tool === "arc" && variant === 0 || tool === "move");
    this.get("sketch-action").hidden = ["select", "project", "point"].includes(tool);
    this.get("sketch-action").toggleAttribute("disabled", !editing.has(tool));
    this.get("sketch-action").textContent = editing.has(tool) ? "Apply " + tool : tool === "spline" ? "Finish spline" : "Add " + tool;
    this.get("sketch-hint").textContent = tool === "select" ? "Click to select. Shift-click adds to the selection. Double-click overlapping geometry to choose. Drag a point or line to reshape." :
      tool === "project" ? "Pick a solid face, edge or vertex to project." :
        editing.has(tool) ? "Select geometry, then apply this tool. Escape returns to selection." : tool === "spline" ? "Pick points, then Finish spline. Escape discards the unfinished spline." :
          tool === "circle" && variant >= 3 ? "Select the tangent curves first, then pick near the wanted center." : "Pick points to draw. Tab edits dimensions beside the geometry; Enter completes it. Escape returns to selection.";
    if (tool === "move") {
      this.input("sketch-angle").value = "0";
    } else if (tool === "arc") {
      this.input("sketch-angle").value = "90";
    }
    this.updateDimensions();
    if (this.proxy) this.hooks.proxy(this.proxy);
    this.display();
    this.handles();
    this.hooks.changed(this.pending);
  }
  escape() {
    if (this.popup?.isConnected) {
      this.popup.remove();
      document.getElementById("model-canvas")!.focus();
      return;
    }
    if (this.creating) {
      void this.queue.then(() => this.choose("select"));
      return;
    }
    if (this.tool === "select") this.selected.clear();
    this.repairingProjection = undefined;
    this.choose("select");
    this.selectionChanged();
    document.getElementById("model-canvas")!.focus();
  }
  private updateDimensions(primitive?: Primitive) {
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
      const w = p.angle === 0 ? Number(p.major) : Number(p.minor), h = p.angle === 0 ? Number(p.minor) : Number(p.major);
      positions.width = [p.center[0], p.center[1] - h];
      positions.height = [p.center[0] + w, p.center[1]];
    } else if (primitive?.type === "line") {
      const p = primitive.parameters;
      positions.width = [(p.from[0] + p.to[0]) / 2, (p.from[1] + p.to[1]) / 2];
    }
    const frame = this.state.frame, offset = this.viewport.pixelLength * 24;
    this.viewport.setSketchInputs([...this.liveDimensions.querySelectorAll<HTMLLabelElement>("label")].filter(row => !row.hidden).map(element => {
      const p = positions[element.querySelector("input")!.id];
      return { element, position: frame.origin.map((v, i) => v + frame.u[i] * p[0] + frame.v[i] * (p[1] + offset)) as [number, number, number] };
    }));
  }
  private snapped(point: Point, excluded = new Set<string>()): Point {
    let result: Point = [...point];
    if (this.input("sketch-grid").checked) {
      result = result.map(v => Math.round(v)) as Point;
    }
    if (this.input("sketch-snap").checked && this.state) {
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
    this.dragQueued = { entity: this.dragEntity, position: line ? { from: translated(line.from), to: translated(line.to) } : target };
    this.flushUpdates();
  }
  private flushUpdates() {
    if (this.updateRunning || this.pending || !this.active || this.creating) return;
    if (!this.dragQueued && !this.previewQueued) return;
    const request = this.dragQueued;
    this.dragQueued = undefined;
    this.previewQueued = false;
    this.updateRunning = true;
    const update = request ? this.run(() => this.sketch!.drag(request.entity, request.position)) : this.preview();
    void update.finally(() => {
      this.updateRunning = false;
      this.flushUpdates();
    });
  }
  click(hit: Hit) {
    if (this.creating) return;
    if (this.pending && editing.has(this.tool)) {
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
    if (editing.has(this.tool)) {
      this.pick(hit.picks[0], hit.additive);
      return;
    }
    if (!hit.point) {
      return;
    }
    this.points.push(this.snapped(hit.point));
    this.cursor = undefined;
    this.updateDimensions();
    const count = this.tool === "point" || this.tool === "text" || this.tool === "circle" && this.variant >= 3 ? 1 : this.tool === "rectangle" && this.variant === 1 || this.tool === "circle" && [1, 2].includes(this.variant) || this.tool === "arc" && this.variant === 1 || this.tool === "slot" && this.variant === 0 ? 3 : 2;
    if (this.tool !== "spline" && this.points.length >= count) {
      this.creating = true;
      void this.run(() => this.create()).finally(() => { this.creating = false; });
    }
    else {
      this.schedulePreview();
    }
  }
  move(point: Point | null) {
    if (!point || !this.sketch || editing.has(this.tool) || this.creating) {
      return;
    }
    this.cursor = this.snapped(point);
    const scale = unitScale[this.scene.units.length];
    const update = (id: string, value: number) => {
      if (!this.dirty.has(id)) {
        this.input(id).value = String(Number(value.toPrecision(15)));
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
        update("sketch-radius", distance(a, b) / scale);
      }
      if (this.tool === "slot" && this.points[1]) {
        update("sketch-radius", distance(this.points[1], b) / scale);
      }
      this.schedulePreview();
      this.updateDimensions();
    }
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
  private async number(id: string, dimension: "length" | "angle" | "scalar" = "length") {
    let source = this.input(id).value.trim();
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
    const text = this.input("sketch-text").value, weight = this.input("sketch-weight").valueAsNumber, fontBase64 = this.fontBase64;
    const horizontal = this.selectValue("sketch-horizontal") as DrawingFields["horizontal"], vertical = this.selectValue("sketch-vertical") as DrawingFields["vertical"], closed = this.input("sketch-closed").checked;
    const [width, height, radius, angle, size] = await Promise.all([field("width", 10), field("height", 10), field("sketch-radius", 5), field("sketch-angle", 90, "angle"), field("sketch-size", 10)]);
    return { width, height, radius, angle, size, text, weight, fontBase64, horizontal, vertical, closed };
  }
  private async primitive(preview = false): Promise<Primitive> {
    const tool = this.tool, variant = this.variant, dirty = new Set(this.dirty);
    const entities = tool === "text" && !this.input("sketch-guide").checked ? [] : this.geometry();
    const construction = this.selectValue("sketch-construction") === "construction", state = this.state!;
    let points = [...this.points];
    if (!points.length) throw new Error("Pick a starting point in the sketch.");
    if (this.cursor && (preview || tool !== "spline" && points.length === 1)) {
      points.push(this.cursor);
    }
    const f = await this.fields();
    if (tool === "line" && dirty.has("width")) {
      const a = points[0], b = points[1] ?? [a[0] + 1, a[1]], angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      points = [a, [a[0] + f.width * Math.cos(angle), a[1] + f.width * Math.sin(angle)]];
    }
    if ((tool === "rectangle" && variant !== 1 || tool === "ellipse") && (dirty.has("width") || dirty.has("height"))) {
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
    const primitive = drawing(tool, variant, points, f, construction, entities, state);
    if (primitive.type === "arc" && variant === 0 && dirty.has("sketch-radius")) primitive.parameters.radius = f.radius;
    if (primitive.type === "slot" && dirty.has("sketch-radius")) {
      primitive.parameters.radius = f.radius;
    }
    return primitive;
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
    if (!editing.has(this.tool)) this.get("sketch-action").setAttribute("disabled", "");
    this.hooks.changed(this.pending);
    if (!this.sketch || editing.has(this.tool) && !["offset", "rounding", "scale", "move"].includes(this.tool) || !editing.has(this.tool) && !this.points.length || !this.active) {
      return;
    }
    if (!editing.has(this.tool) && this.points.length === 1 && !this.cursor && !this.dirty.size) return;
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
        await this.add(primitive, true);
        if (interaction === this.interaction && version === this.version && this.active && !this.creating) this.updateDimensions(primitive);
      }
      if (interaction !== this.interaction || !this.active || this.creating) return;
      // Both reads must settle before another update can replace the preview cache.
      const results = await Promise.allSettled([this.sketch!.state({ preview: true }), this.sketch!.getProxy({ preview: true })]);
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
          if ((g.type === "circle" || g.type === "arc") && this.input("sketch-radius").closest<HTMLElement>("label")!.hidden) {
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
        this.draftValid = version === this.version;
        this.get("sketch-action").toggleAttribute("disabled", !this.draftValid);
        if (this.draftValid) this.showError("");
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
  private async create() {
    const version = ++this.version, tool = this.tool;
    this.interaction++;
    this.previewQueued = false;
    const primitive = await this.primitive();
    if (version !== this.version) return;
    const result = await this.add(primitive);
    if (primitive.type === "rectangle") {
      for (const [id, index] of [["width", 0], ["height", 1]] as const) {
        if (this.dirty.has(id)) {
          await this.sketch!.dimensions.add("length", { line: result.curves[index], value: this.input(id).value, mode: "driving" });
        }
      }
    }
    else if (["circle", "arc", "slot"].includes(primitive.type) && this.dirty.has("sketch-radius")) {
      await this.sketch!.dimensions.add("radius", { curve: result.curves[0], value: this.input("sketch-radius").value, mode: "driving" });
    }
    if (primitive.type === "ellipse") {
      const p = primitive.parameters;
      const widthIsMajor = p.angle === 0;
      for (const [id, kind] of [["width", widthIsMajor ? "majorRadius" : "minorRadius"], ["height", widthIsMajor ? "minorRadius" : "majorRadius"]] as const) {
        if (this.dirty.has(id)) {
          await this.sketch!.dimensions.add(kind, { curve: result.curves[0], mode: "driving", value: `(${this.input(id).value}) / 2` });
        }
      }
    }
    if (primitive.type === "arc" && this.variant === 0) {
      await this.sketch!.dimensions.add("angle", { curve: result.curves[0], mode: "driving", value: this.input("sketch-angle").value });
    }
    if (primitive.type === "line" && this.dirty.has("width")) {
      await this.sketch!.dimensions.add("length", { line: result.curves[0], mode: "driving", value: this.input("width").value });
    }
    if (this.tool === "circle" && this.variant >= 3) {
      for (const entity of this.geometry()) {
        await this.sketch!.constraints.add("tangent", { curves: [entity.reference, result.curves[0]] });
      }
    }
    const state = await this.sketch!.state();
    for (const point of result.points) {
      const position = pointOf(state, point.id);
      const reference = [...this.snapRefs].find(([key]) => distance(key.split(",").map(Number) as Point, position) < 1e-7)?.[1];
      if (reference) {
        await this.sketch!.constraints.add("coincident", { points: [reference, point] });
      }
    }
    if (primitive.type === "circle" && [1, 2].includes(this.variant) || primitive.type === "arc" && this.variant === 1) {
      for (const reference of this.snapRefs.values()) {
        await this.sketch!.constraints.add("pointOnCurve", { points: [reference], curves: [result.curves[0]] });
      }
    }
    this.points = [];
    this.cursor = undefined;
    this.snapRefs.clear();
    this.dirty.clear();
    this.hooks.status(title(tool) + " added");
    this.choose("select");
  }
  addConstraint(kind: ConstraintKind) {
    return this.run(async () => {
      const entities = this.geometry();
      await this.sketch!.constraints.add(kind, { points: entities.filter(e => e.geometry.type === "point").map(e => e.reference), curves: entities.filter(e => e.geometry.type !== "point").map(e => e.reference) });
      this.choose("select");
    });
  }
  deleteSelected() {
    if (!this.selected.size || this.pending) return;
    return this.run(async () => {
      await this.sketch!.remove([...this.selected]);
      this.selected.clear();
    });
  }
  private async action(preview = false) {
    if (!editing.has(this.tool)) {
      return this.create();
    }
    const entities = this.geometry(), curves = entities.filter(e => e.geometry.type !== "point").map(e => e.reference);
    if (this.tool === "dimension") {
      const kind = dimensionKinds[this.variant], value = this.input("sketch-dimension-value").value.trim();
      const points = entities.filter(e => e.geometry.type === "point").map(e => e.reference);
      await this.sketch!.dimensions.add(kind, { ...(kind === "length" ? { line: curves[0] } : ["radius", "diameter", "majorRadius", "minorRadius"].includes(kind) ? { curve: curves[0] } : kind === "angle" ? { curves } : { points }), mode: this.selectValue("sketch-dimension-mode") === "driven" || !value ? "driven" : "driving", ...(value ? { value } : {}) });
    }
    else if (this.tool === "split") {
      await this.sketch!.modifyCurves(curves, { type: "split" });
    }
    else if (this.tool === "rounding") {
      await this.sketch!.modifyCurves(curves, { type: "rounding", radius: this.input("sketch-radius").value }, { preview });
    }
    else if (this.tool === "offset") {
      await this.sketch!.modifyCurves(curves, { type: "offset", distance1: this.input("sketch-offset").value, ...(this.variant ? { distance2: this.input(this.variant === 1 ? "sketch-offset" : "sketch-offset2").value } : {}) }, { preview });
    }
    else if (this.tool === "scale" || this.tool === "move") {
      await this.sketch!.transform({ preview, entities: entities.map(e => e.reference), pivot: this.pivot, copy: this.input("sketch-copy").checked, ...(this.tool === "scale" ? { scale: this.input("sketch-scale").value } : { translation: [await this.number("sketch-move-x"), await this.number("sketch-move-y")] as Point, angle: this.input("sketch-angle").value }) });
    }
    if (!preview) {
      this.choose("select");
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
            this.input(id).value=String(Number((value/unitScale[unit]).toPrecision(12)))+(unit==="scalar"?"":" "+unit);
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
    const menu = document.createElement("div");
    menu.className = "sketch-popup";
    menu.style.left = client[0] + "px";
    menu.style.top = client[1] + "px";
    document.body.append(menu);
    this.popup = menu;
    return menu;
  }
  private editDimension(id: string, client: Point) {
    const d = this.state?.dimensions.find(d => d.id === id);
    if (!d) {
      return;
    }
    const menu = this.menuAt(client);
    const form = document.createElement("form");
    const name = document.createElement("input");
    name.value = d.parameters.name ?? d.id;
    name.setAttribute("aria-label", "Dimension name");
    const value = document.createElement("input");
    const formula = d.parameters.value;
    value.value = typeof formula === "object" ? formula.expression : String(formula ?? `${d.computed.value} ${d.computed.unit}`);
    value.setAttribute("aria-label", "Dimension formula");
    const mode = document.createElement("select");
    mode.setAttribute("aria-label", "Dimension mode");
    for (const m of ["driving", "driven"]) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = title(m);
      mode.append(o);
    }
    mode.value = d.parameters.mode;
    const save = document.createElement("button");
    save.textContent = "Apply dimension";
    form.append(name, value, mode, save);
    form.onsubmit = e => {
      e.preventDefault();
      this.run(async () => {
        await this.sketch!.dimensions.update(id, { name: name.value, value: value.value, mode: mode.value as "driving" | "driven" });
        menu.remove();
      });
    };
    menu.append(form);
    value.focus();
    value.select();
  }
  suspend() {
    this.viewport.pickVertices = false;
    this.active = false;
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
      const pick = this.viewport.sketchPicks(e).find(p => p.kind === "dimension");
      if (pick) {
        e.preventDefault();
        this.editDimension(pick.id, [e.clientX, e.clientY]);
      }
    }, { signal });
    document.addEventListener("keydown", e => {
      if (e.defaultPrevented || e.target instanceof Element && e.target.closest("dialog, .sketch-popup")) {
        return;
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
      if (e.key === "Enter" && e.target instanceof HTMLInputElement && (this.get("sketch-config").contains(e.target) || this.liveDimensions.contains(e.target))) {
        e.preventDefault();
        if (!this.creating) {
          this.creating = true;
          void this.run(() => this.action()).finally(() => { this.creating = false; });
        }
      }
    }, { signal });
    document.addEventListener("pointerdown", e => {
      if (this.popup && !this.popup.contains(e.target as Node)) {
        this.popup.remove();
      }
    }, { signal });
    canvas.addEventListener("pointerdown", e => {
      if (e.button === 0) canvas.focus({ preventScroll: true });
      if (e.button !== 0 || this.tool !== "select" || this.pending) {
        return;
      }
      const pick = this.viewport.sketchPicks(e)[0];
      const entity = pick?.kind === "geometry" ? this.state?.entities.find(entity => entity.reference.id === pick.id) : undefined;
      if (!entity || entity.projected || (entity.geometry.type !== "point" && entity.geometry.type !== "line")) {
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
      this.dragLine = geometry.type === "line" ? { cursor, from: [...pointOf(this.state!, geometry.from)], to: [...pointOf(this.state!, geometry.to)] } : undefined;
      this.dragPosition = geometry.type === "point" ? geometry.position : cursor;
      this.dragExcluded = new Set(geometry.type === "line" ? [geometry.from, geometry.to] : [entity.reference.id]);
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
    }, { capture: true, signal });
    canvas.addEventListener("pointermove", e => {
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
      if (!this.dragEntity || e.button !== 0) {
        return;
      }
      e.stopImmediatePropagation();
      const ref = this.dragEntity;
      if (this.dragMoved) {
        const point = this.viewport.point(e);
        if (point) this.queueDrag(point);
      } else {
        this.pick({ kind: "geometry", id: ref.id }, e.shiftKey);
      }
      this.dragEntity = undefined;
      this.dragLine = undefined;
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    }, { capture: true, signal });
    const clearDrag = () => {
      // A normal release has already cleared dragEntity and must retain its queued target.
      if (this.dragEntity) this.dragQueued = undefined;
      this.dragEntity = undefined;
      this.dragLine = undefined;
      this.dragStart = undefined;
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
  }
  async finish() {
    this.version++;
    this.interaction++;
    this.previewQueued = false;
    await this.queue;
    if (!this.sketch) {
      throw new Error("Choose a sketch plane first.");
    }
    if (this.points.length && !editing.has(this.tool)) {
      await this.create();
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
    this.viewport.sketching(false);
    this.viewport.restoreView(this.previousView);
    this.hooks.visibility(false);
  }
}
