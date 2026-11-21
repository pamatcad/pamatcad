import { Body, type BodyProxy, type ExtrudeParameters, type FaceProperties, type PlaneFrame,
  type Profiles, type Scene, type SketchProxy, type Transport, type Parameters } from "@pamatcad/sdk";
import { FormulaInput } from "../formula-input";
import { accepts, changeSelection, selectionKey, type SelectionFilter, type SelectionItem } from "../selection";
import type { ToolHandle } from "../tool-handles";

type Slot = "profiles" | "start" | "limit1" | "limit2" | "targets";
type Callbacks = {
  changed(): void;
  preview(bodies?: BodyProxy[], removed?: string[]): void;
  handles(items?: ToolHandle[]): void;
  status(text: string): void;
};
type Request = Parameters<"solid.extrude">;

export class ExtrudeTool {
  private previewPending = false;
  private selecting = 0;
  private version = 0;
  private interaction = 0;
  private handleInput = false;
  private validVersion = -1;
  private request?: Request;
  private active = true;
  private disposed = false;
  private slot: Slot = "profiles";
  private inputs: Record<Slot, SelectionItem[]> = { profiles: [], start: [], limit1: [], limit2: [], targets: [] };
  private formulas = new Map<string, FormulaInput>();
  private faces = new Map<string, FaceProperties>();
  private frame?: PlaneFrame;
  private center: [number, number, number] = [0, 0, 0];
  private radius = 5;
  private selectionVersion = 0;
  private failure: HTMLElement;

  constructor(readonly panel: HTMLElement, private scene: Scene, private transport: Transport,
    private sketches: Map<string, SketchProxy>, private bodies: Map<string, BodyProxy>, private callbacks: Callbacks) {
    this.failure = panel.querySelector<HTMLElement>("#extrude-error")!;
    for (const [id, dimension] of [["length", "length"], ["length2", "length"], ["offset", "length"],
      ["taper1", "angle"], ["taper2", "angle"]] as const) {
      this.formulas.set(id, new FormulaInput(this.field(id), dimension, scene, () => this.change()));
    }
    for (const select of panel.querySelectorAll("select")) select.onchange = () => {
      if (select.id === "extrude-mode" && select.value !== "auto") {
        select.querySelector<HTMLOptionElement>('option[value="auto"]')!.disabled = true;
      }
      this.change();
    };
    this.field("extrude-reverse").onchange = () => this.change();
    for (const slot of ["profiles", "start", "limit1", "limit2", "targets"] as const) {
      this.button("pick-" + slot).onclick = () => { this.selectionVersion++; this.slot = slot; this.updateForm(); this.callbacks.changed(); };
      this.button("clear-" + slot).onclick = () => { this.selectionVersion++; this.inputs[slot] = []; this.slot = slot; this.change(); };
    }
    this.updateForm();
  }

  private field(id: string) { return this.panel.querySelector<HTMLInputElement>("#" + id)!; }
  private button(id: string) { return this.panel.querySelector<HTMLButtonElement>("#" + id)!; }
  private value(id: string) { return this.field(id).value; }
  get selection() { return this.inputs[this.slot]; }
  get profiles() { return this.inputs.profiles; }
  get pending() { return this.previewPending || this.selecting > 0; }
  get filter(): SelectionFilter { return this.slot === "profiles" ? "profiles" : this.slot === "start" ? "faces" : "bodies"; }
  get ready() { return !this.pending && this.validVersion === this.version && !!this.request; }

  async seed(selection: SelectionItem[]) {
    for (const item of selection) await this.select(item, true, true);
    this.change();
  }

  async select(item: SelectionItem | undefined, additive: boolean, seeding = false) {
    if (this.disposed || (item && !accepts(this.filter, item))) return;
    const slot = this.slot;
    const version = ++this.selectionVersion;
    this.interaction++;
    // Keep Apply and document switching disabled while validating a picked face.
    this.selecting++;
    this.callbacks.changed();
    try {
      let items: SelectionItem[] = item ? [item] : [];
      if (slot === "profiles" && item?.kind === "sketch") {
        items = (this.sketches.get(item.id)?.regions ?? []).map(({ region }) => ({ kind: "region", ref: region }));
      }
      if (item?.kind === "face") {
        const key = selectionKey(item);
        if (!this.faces.has(key)) this.faces.set(key, await new Body(this.transport, { sceneId: this.scene.id, id: item.ref.bodyId }).faces.properties(item.ref));
        if (slot === "profiles" && !this.faces.get(key)?.frame) throw new Error("Select a planar face for the profile.");
      }
      if (version !== this.selectionVersion || this.disposed || slot !== this.slot) return;
      let next = additive ? this.inputs[slot] : [];
      if (slot === "profiles") {
        const first = next[0];
        for (const candidate of items) {
          if (first && first.kind !== candidate.kind) throw new Error("Select sketch regions or planar faces together.");
          if (first?.kind === "region" && candidate.kind === "region" && first.ref.sketchId !== candidate.ref.sketchId)
            throw new Error("Select regions from one sketch.");
          if (first?.kind === "face" && candidate.kind === "face") {
            const a = this.faces.get(selectionKey(first))!.frame!, b = this.faces.get(selectionKey(candidate))!.frame!;
            const dot = (x: number[], y: number[]) => x.reduce((sum, n, i) => sum + n * y[i], 0);
            if (Math.hypot(dot(a.u, b.normal), dot(a.v, b.normal)) > 1e-10 ||
              Math.abs(dot(b.origin.map((n, i) => n - a.origin[i]), a.normal)) > 1e-7) throw new Error("Select coplanar faces.");
          }
        }
      }
      if (slot === "start" || slot === "limit1" || slot === "limit2") next = items.slice(-1);
      else if (items.length) for (const candidate of items) {
        if (!seeding || !next.some((existing) => selectionKey(existing) === selectionKey(candidate))) next = changeSelection(next, candidate, true);
      }
      else if (!additive) next = [];
      this.inputs[slot] = next;
      if (!seeding) this.change();
    } catch (error) {
      if (!seeding && !this.disposed && version === this.selectionVersion) {
        this.change();
        this.callbacks.status(error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.selecting--;
      this.callbacks.changed();
      if (!seeding && !this.selecting && !this.disposed && this.active && !this.ready) {
        void this.preview();
      }
    }
  }

  private updateForm() {
    const type = this.value("extrude-type"), start = this.value("extrude-start"), mode = this.value("extrude-mode");
    const show = (id: string, visible: boolean) => { this.panel.querySelector<HTMLElement>("#" + id)!.hidden = !visible; };
    show("offset-field", start === "offset");
    show("start-selection", start === "object");
    show("side2", type === "twoSides");
    show("symmetric-field", type === "symmetric");
    show("extrude-direction-field", type !== "symmetric" && (this.value("extent1") !== "length" ||
      (type === "twoSides" && this.value("extent2") !== "length")));
    show("targets-section", mode !== "newBody");
    show("target-selection", mode !== "newBody" && this.value("target-scope") === "selected");
    for (const side of [1, 2]) {
      const extent = type === "symmetric" ? "length" : this.value("extent" + side);
      show("extent" + side + "-field", type !== "symmetric");
      show("length" + side + "-field", extent === "length");
      show("limit" + side + "-selection", extent === "toObject");
    }
    if ((this.slot === "start" && start !== "object") || (this.slot === "targets" &&
      (mode === "newBody" || this.value("target-scope") !== "selected")) ||
      (this.slot === "limit1" && (type === "symmetric" || this.value("extent1") !== "toObject")) ||
      (this.slot === "limit2" && (type !== "twoSides" || this.value("extent2") !== "toObject"))) this.slot = "profiles";
    for (const slot of Object.keys(this.inputs) as Slot[]) {
      const pick = this.button("pick-" + slot);
      pick.setAttribute("aria-pressed", String(slot === this.slot));
      const count = this.inputs[slot].length;
      pick.textContent = count ? `${count} selected · Change` : "Select…";
      this.button("clear-" + slot).disabled = !count;
      this.panel.querySelector<HTMLElement>("#" + slot + "-items")!.textContent = this.inputs[slot].map((item) => {
        if (item.kind === "region") {
          const sketch = this.sketches.get(item.ref.sketchId)!;
          return `Region ${sketch.regions.findIndex((r) => r.region.id === item.ref.id) + 1} · Sketch ${[...this.sketches.keys()].indexOf(item.ref.sketchId) + 1}`;
        }
        if (item.kind === "face") return `Face ${"faceId" in item.ref ? item.ref.faceId : ""} · Body ${[...this.bodies.keys()].indexOf(item.ref.bodyId) + 1}`;
        return item.kind === "body" ? `Body ${[...this.bodies.keys()].indexOf(item.id) + 1}` : "";
      }).join(", ");
    }
    this.panel.querySelector<HTMLElement>("#selection-hint")!.textContent = {
      profiles: "Select sketch regions or coplanar faces. Shift-click adds or removes.",
      start: "Select a starting face.", limit1: "Select the limiting body for side 1.",
      limit2: "Select the limiting body for side 2.", targets: "Select target bodies. Shift-click adds or removes.",
    }[this.slot];
  }

  private change() {
    this.version++;
    // Completed handle steps may be displayed while the next step is pending.
    // Typed edits and changes to geometry or options start a new interaction.
    if (!this.handleInput) this.interaction++;
    this.validVersion = -1;
    this.failure.textContent = "";
    this.updateForm();
    if (!this.inputs.profiles.length || (this.value("extrude-start") === "object" && !this.inputs.start.length)) this.callbacks.handles();
    this.callbacks.changed();
    void this.preview();
  }

  private async build(): Promise<Request> {
    const selected = this.inputs.profiles;
    if (!selected.length) throw new Error("Select an extrusion profile.");
    let profile: Profiles;
    const points: number[][] = [];
    if (selected[0].kind === "region") {
      const regions = selected.map((item) => (item as Extract<SelectionItem, { kind: "region" }>).ref);
      profile = regions;
      const proxy = this.sketches.get(regions[0].sketchId)!;
      this.frame = proxy.frame;
      for (const region of regions) points.push(...proxy.regions.find((r) => r.region.id === region.id)!.boundary);
    } else {
      const faces = selected as Extract<SelectionItem, { kind: "face" }>[];
      profile = faces.map((item) => item.ref);
      this.frame = this.faces.get(selectionKey(faces[0]))!.frame!;
      for (const item of faces) {
        const proxy = this.bodies.get(item.ref.bodyId)!;
        const range = proxy.faces.find((f) => selectionKey({ kind: "face", ref: f.face, revision: proxy.revision }) === selectionKey(item))!;
        for (let i = range.firstTriangle * 3; i < (range.firstTriangle + range.triangleCount) * 3; i++) {
          const index = proxy.triangles[i] * 3;
          points.push(Array.from(proxy.positions.subarray(index, index + 3)));
        }
      }
    }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const point of points) for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], point[i]); max[i] = Math.max(max[i], point[i]);
    }
    this.center = min.map((n, i) => (n + max[i]) / 2) as [number, number, number];
    const distance = this.frame.normal.reduce((sum, n, i) => sum + (this.center[i] - this.frame!.origin[i]) * n, 0);
    this.center = this.center.map((n, i) => n - distance * this.frame!.normal[i]) as [number, number, number];
    this.radius = points.reduce((radius, p) => Math.max(radius, Math.hypot(...p.map((n, i) => n - this.center[i]))), 1);
    const type = this.value("extrude-type") as NonNullable<ExtrudeParameters["type"]>;
    const parameters: ExtrudeParameters = { type, mode: this.value("extrude-mode") as NonNullable<ExtrudeParameters["mode"]> };
    const reverse = type !== "symmetric" && this.field("extrude-reverse").checked &&
      (this.value("extent1") !== "length" || (type === "twoSides" && this.value("extent2") !== "length"));
    if (reverse) parameters.direction = "negative";
    const fields: string[] = [];
    if (this.value("extrude-start") === "offset") { parameters.start = { type: "offset", offset: this.value("offset") }; fields.push("offset"); }
    else if (this.value("extrude-start") === "object") {
      const face = this.inputs.start[0];
      if (face?.kind !== "face") throw new Error("Select a starting face.");
      parameters.start = { type: "object", face: face.ref };
    } else parameters.start = { type: "profilePlane" };
    for (const side of (type === "twoSides" ? [1, 2] : [1]) as (1 | 2)[]) {
      const extent = type === "symmetric" ? "length" : this.value("extent" + side);
      if (extent === "length") {
        const id = side === 1 ? "length" : "length2";
        // The API direction reverses both sides. Compensate length extents so the
        // editor's Reverse checkbox affects only extents without a signed length.
        parameters[side === 1 ? "length1" : "length2"] = reverse ? `-(${this.value(id)})` : this.value(id);
        parameters[side === 1 ? "extent1" : "extent2"] = { type: "length" };
        fields.push(id);
      } else if (extent === "throughAll") parameters[side === 1 ? "extent1" : "extent2"] = { type: "throughAll" };
      else {
        const limit = this.inputs[side === 1 ? "limit1" : "limit2"][0];
        if (limit?.kind !== "body") throw new Error(`Select the limiting body for side ${side}.`);
        parameters[side === 1 ? "extent1" : "extent2"] = { type: "toObject", body: { sceneId: this.scene.id, id: limit.id },
          extent: this.value("object-extent" + side) as "closest" | "touch" | "intersect" | "farthest" };
      }
      parameters[side === 1 ? "taperAngle1" : "taperAngle2"] = this.value("taper" + side);
      fields.push("taper" + side);
    }
    if (type === "symmetric") parameters.symmetricLength = this.value("symmetric-length") as "total" | "half";
    const results = await Promise.allSettled(fields.map((id) => this.formulas.get(id)!.evaluate()));
    const invalid = results.find((r) => r.status === "rejected");
    if (invalid?.status === "rejected") throw invalid.reason;
    let targets: Request["targets"];
    if (parameters.mode !== "newBody" && this.value("target-scope") === "selected") {
      targets = this.inputs.targets.filter((item) => item.kind === "body").map((item) => ({ sceneId: this.scene.id, id: item.id }));
      if (!targets.length) throw new Error("Select at least one target body, or choose All bodies.");
    }
    return { profile, parameters, ...(targets ? { targets } : {}) };
  }

  private updateHandles() {
    if (!this.frame) { this.callbacks.handles(); return; }
    const { normal, u } = this.frame;
    let offset = this.value("extrude-start") === "offset" ? this.formulas.get("offset")!.value : 0;
    if (this.value("extrude-start") === "object") {
      const face = this.inputs.start[0];
      if (face?.kind === "face") {
        const proxy = this.bodies.get(face.ref.bodyId)!;
        const range = proxy.faces.find((f) => selectionKey({ kind: "face", ref: f.face, revision: proxy.revision }) === selectionKey(face));
        if (range) {
          const values: number[] = [];
          for (let i = range.firstTriangle * 3; i < (range.firstTriangle + range.triangleCount) * 3; i++) {
            const vertex = proxy.triangles[i] * 3;
            values.push(normal.reduce((sum, n, j) => sum + (proxy.positions[vertex + j] - this.frame!.origin[j]) * n, 0));
          }
          const min = Math.min(...values), max = Math.max(...values);
          offset = min > 0 ? min : max < 0 ? max : 0;
        }
      }
    }
    const origin = this.center.map((n, i) => n + normal[i] * offset) as [number, number, number];
    const handles: ToolHandle[] = [];
    const add = (id: string, label: string, at: [number, number, number], direction: [number, number, number], factor = 1) => {
      const field = this.formulas.get(id)!;
      handles.push({ id, label, origin: at, direction, tangent: u, kind: field.dimension, value: field.value, unit: field.unit, factor,
        change: (value) => {
          this.handleInput = true;
          try { field.setFromHandle(value); }
          finally { this.handleInput = false; }
        } });
    };
    if (this.value("extrude-start") === "offset") add("offset", "Start offset", this.center, normal);
    const type = this.value("extrude-type");
    for (const side of (type === "oneSide" ? [1] : [1, 2])) {
      const extent = type === "symmetric" ? "length" : this.value("extent" + side);
      const direction = normal.map((n) => n * (side === 1 ? 1 : -1)) as [number, number, number];
      const id = type === "symmetric" || side === 1 ? "length" : "length2";
      const factor = type === "symmetric" && this.value("symmetric-length") === "total" ? 0.5 : 1;
      if (extent === "length") {
        add(id, type === "symmetric" ? "Symmetric length" : "Length " + side, origin, direction, factor);
        if (type === "symmetric") handles[handles.length - 1].id += "-side" + side;
      }
      if (type !== "symmetric" || side === 1) {
        const reverse = extent === "length" ? this.formulas.get(id)!.value < 0 : this.field("extrude-reverse").checked;
        const taperDirection = direction.map((n) => n * (reverse ? -1 : 1)) as [number, number, number];
        const at = origin.map((n, i) => n + u[i] * (this.radius + 4) * (side === 1 ? 1 : -1) + taperDirection[i] * 2) as [number, number, number];
        add("taper" + side, "Taper " + side, at, taperDirection);
      }
    }
    this.callbacks.handles(handles);
  }

  private async preview() {
    if (this.pending || !this.active || this.disposed) return;
    const version = this.version;
    const interaction = this.interaction;
    this.previewPending = true;
    this.callbacks.changed();
    let built = false;
    try {
      const request = await this.build();
      if (interaction !== this.interaction || !this.active || this.disposed) return;
      built = true;
      if (version === this.version) this.updateHandles();
      const result = await this.transport.request("solid.extrude", { ...request, preview: true });
      if (!("revision" in result)) throw new Error("Expected an extrusion preview.");
      if (interaction !== this.interaction || !this.active || this.disposed) return;
      const meshes = await Promise.allSettled([...result.newSolids, ...result.affectedSolids].map((body) =>
        this.scene.getProxyFor(body, { preview: true, revision: result.revision })));
      if (interaction !== this.interaction || !this.active || this.disposed) return;
      const proxies = meshes.map((mesh) => {
        if (mesh.status === "rejected") throw mesh.reason;
        return mesh.value;
      });
      this.request = request;
      this.validVersion = version;
      if (version === this.version && request.parameters.mode === "auto") {
        const mode = result.operation.resolvedMode;
        const label = mode === "join" ? "Join" : mode === "cut" ? "Cut" : "New";
        this.panel.querySelector<HTMLOptionElement>('#extrude-mode option[value="auto"]')!.textContent = "Auto — " + label;
      }
      this.callbacks.preview(proxies, result.removedSolids.map((body) => body.id));
      this.callbacks.status(version === this.version ? "Extrusion preview" : "Updating extrusion preview…");
    } catch (error) {
      if (version === this.version && interaction === this.interaction && this.active && !this.disposed) {
        this.validVersion = -1;
        this.callbacks.preview();
        if (!built) this.callbacks.handles();
        const message = error instanceof Error ? error.message : String(error);
        this.failure.textContent = message;
        this.callbacks.status(message);
        await this.scene.discardPreview();
      }
    } finally {
      if (this.disposed) {
        try { await this.scene.discardPreview(); }
        catch (error) { this.callbacks.status(String(error)); }
      }
      this.previewPending = false;
      this.callbacks.changed();
      if (this.version !== version || this.interaction !== interaction) void this.preview();
    }
  }

  async apply() {
    if (!this.ready || !this.request) throw new Error("Wait for a valid preview before applying.");
    return this.transport.request("solid.extrude", this.request);
  }

  suspend() { this.active = false; this.interaction++; }
  resume() { this.active = true; this.updateForm(); this.callbacks.changed(); if (!this.ready) this.change(); else this.updateHandles(); }
  close(discard = true) {
    this.disposed = true;
    this.version++;
    this.callbacks.handles();
    if (discard && !this.previewPending) void this.scene.discardPreview().catch((error) => this.callbacks.status(String(error)));
  }
}
