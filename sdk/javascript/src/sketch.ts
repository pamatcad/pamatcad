import type { CircleData, CircleParameters, RectangleData, RectangleParameters, SketchData, SketchRef, SketchSupport,
  SketchEntityRef, Primitive, GeometryData, ConstraintKind, ConstraintParameters, DimensionKind, DimensionParameters,
  UpdateDimension, SketchSettings, ProjectionSource, TransformSketchGeometry, SketchCurveEdit } from "./generated/protocol.js";
import type { Transport } from "./transport.js";

type PrimitiveParameters<K extends Primitive["type"]> = Extract<Primitive, { type: K }>["parameters"];
export class Sketch<P extends SketchSupport = SketchSupport> {
  readonly id;
  readonly sceneId;
  readonly plane: P;
  readonly origin: SketchEntityRef;
  readonly primitives;
  readonly constraints;
  readonly dimensions;
  readonly regions;
  readonly projections;
  readonly support;
  private readonly reference: SketchRef;

  constructor(private readonly transport: Transport, data: SketchData & { plane: P }) {
    this.id = data.id;
    this.sceneId = data.sceneId;
    this.plane = data.plane;
    this.reference = { sceneId: data.sceneId, id: data.id };
    this.origin = { sceneId: this.sceneId, sketchId: this.id, id: "origin" };
    const sketch = this.reference;
    function add(type: "rectangle", parameters: RectangleParameters, options?: { preview?: boolean }): Promise<RectangleData>;
    function add(type: "circle", parameters: CircleParameters, options?: { preview?: boolean }): Promise<CircleData>;
    function add<K extends Exclude<Primitive["type"], "rectangle" | "circle">>(type: K, parameters: PrimitiveParameters<K>, options?: { preview?: boolean }): Promise<GeometryData>;
    function add(type: Primitive["type"], parameters: Primitive["parameters"], options: { preview?: boolean } = {}) {
      return transport.request("sketch.primitives.add", { sketch, primitive: { type, parameters } as Primitive, ...options });
    }
    this.primitives = { add };
    this.projections = {
      add: (source: ProjectionSource) => transport.request("sketch.project", { sketch, source }),
      update: (id: string, source: ProjectionSource) => transport.request("sketch.project", { sketch, source, id }),
      all: async () => (await this.state()).projections,
    };
    this.support = { update: (plane: SketchSupport) => transport.request("sketch.support.update", { sketch, plane }) };
    this.constraints = {
      add: (kind: ConstraintKind, parameters: ConstraintParameters) => transport.request("sketch.constraints.add", { sketch, kind, parameters }),
      all: async () => (await this.state()).constraints,
      remove: (id: string) => this.remove([id]),
    };
    this.dimensions = {
      add: (kind: DimensionKind, parameters: DimensionParameters) => transport.request("sketch.dimensions.add", { sketch, kind, parameters }),
      update: (id: string, parameters: Omit<UpdateDimension, "sketch" | "id">) => transport.request("sketch.dimensions.update", { sketch, id, ...parameters }),
      all: async () => (await this.state()).dimensions,
      get: async (id: string) => {
        const dimension = (await this.state()).dimensions.find(d => d.id === id);
        if (!dimension) throw new Error(`Dimension ${id} does not exist`);
        return dimension;
      },
      findByName: async (name: string) => {
        const dimension = (await this.state()).dimensions.find(d => d.parameters.name === name);
        if (!dimension) throw new Error(`Dimension ${name} does not exist`);
        return dimension;
      },
      remove: (id: string) => this.remove([id]),
    };
    this.regions = {
      all: () => transport.request("sketch.regions.all", { sketch }),
      only: () => transport.request("sketch.regions.only", { sketch }),
    };
  }

  async complete(): Promise<void> { await this.transport.request("sketch.complete", { sketch: this.reference }); }
  async edit(): Promise<void> { await this.transport.request("sketch.edit", { sketch: this.reference }); }
  async cancel(): Promise<void> { await this.transport.request("sketch.cancel", { sketch: this.reference }); }
  state(options: { preview?: boolean } = {}) { return this.transport.request("sketch.state", { sketch: this.reference, ...options }); }
  settings(options: Omit<SketchSettings, "sketch">) { return this.transport.request("sketch.settings", { sketch: this.reference, ...options }); }
  recompute() { return this.transport.request("sketch.recompute", { sketch: this.reference }); }
  modifyCurves(curves: SketchEntityRef[], operation: SketchCurveEdit, options: {preview?: boolean} = {}) { return this.transport.request("sketch.curves.modify", { sketch: this.reference, curves, operation, ...options }); }
  transform(options: Omit<TransformSketchGeometry, "sketch">) { return this.transport.request("sketch.transform", { sketch: this.reference, ...options }); }
  construction(entities: SketchEntityRef[], construction: boolean) { return this.transport.request("sketch.construction", { sketch: this.reference, entities, construction }); }
  remove(ids: string[]) { return this.transport.request("sketch.remove", { sketch: this.reference, ids }); }
  drag(entity: SketchEntityRef, position: [number, number] | { from: [number, number]; to: [number, number] }) {
    return this.transport.request("sketch.drag", Array.isArray(position)
      ? { sketch: this.reference, point: entity, position }
      : { sketch: this.reference, line: entity, ...position });
  }
  getProxy(options: { preview?: boolean } = {}) { return this.transport.request("sketch.getProxy", { sketch: this.reference, ...options }); }
}
