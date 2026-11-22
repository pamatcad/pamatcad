import type { BodyProxy as WireBodyProxy, BodyRef, ProxyQuery, AngleUnit, CaptureScene, EncodedFile, EvaluatedFormula, ExportScene, Formula, FormulaDimension, FormulaUnit, LengthUnit, SketchSupport, SceneData } from "./generated/protocol.js";
import { Sketch } from "./sketch.js";
import { Body } from "./solid.js";
import type { Transport } from "./transport.js";

export type BodyProxy = Omit<WireBodyProxy, "positions" | "normals" | "triangles" | "edgePoints"> & {
  positions: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  edgePoints: Float32Array;
};

export type ExportOptions = Omit<ExportScene, "sceneId">;
export type CaptureOptions = Omit<CaptureScene, "sceneId">;
export type SceneFile = { mediaType: string; bytes: Uint8Array };

function decode({ mediaType, base64 }: EncodedFile): SceneFile {
  return { mediaType, bytes: Uint8Array.from(atob(base64), char => char.charCodeAt(0)) };
}

export class Scene {
  readonly id;
  readonly name;
  readonly construction;
  readonly units;
  readonly sketches;
  readonly bodies;
  readonly timeline;

  constructor(private readonly transport: Transport, data: SceneData) {
    this.id = data.id;
    this.name = data.name;
    this.construction = data.construction;
    this.units = Object.freeze({ ...data.units });
    this.timeline = { list: () => transport.request("scene.timeline.list", { sceneId: this.id }) };
    this.sketches = {
      findByName: async (name: string) => new Sketch(transport, await transport.request("sketch.find", { sceneId: this.id, name })),
      get: async (id: string) => new Sketch(transport, await transport.request("sketch.find", { sceneId: this.id, id })),
      getProxy: (id: string) => transport.request("sketch.getProxy", { sketch: { sceneId: this.id, id } }),
      create: async <P extends SketchSupport>(plane: P, options: { name?: string } = {}): Promise<Sketch<P>> => {
        if (plane.sceneId !== this.id) throw new Error("Sketch support belongs to another scene");
        const data = await transport.request("sketch.create", { plane, ...options });
        return new Sketch(transport, { ...data, plane: { ...plane } });
      },
    };
    this.bodies = {
      revisions: () => transport.request("scene.bodies.revisions", { sceneId: this.id }),
      all: () => transport.request("scene.bodies.all", { sceneId: this.id }),
      get: async (id: string): Promise<Body> => new Body(transport,
        await transport.request("body.get", { body: { sceneId: this.id, id } })),
    };
  }

  evaluateFormula(expression: Formula<LengthUnit>, options: { expectedDimension: "length" }): Promise<EvaluatedFormula<LengthUnit>>;
  evaluateFormula(expression: Formula<AngleUnit>, options: { expectedDimension: "angle" }): Promise<EvaluatedFormula<AngleUnit>>;
  evaluateFormula(expression: Formula<FormulaUnit>, options: { expectedDimension: FormulaDimension }): Promise<EvaluatedFormula<FormulaUnit>>;
  evaluateFormula(expression: Formula<FormulaUnit>, options: { expectedDimension: FormulaDimension }) {
    return this.transport.request("scene.evaluateFormula", {
      sceneId: this.id, expression, expectedDimension: options.expectedDimension,
    });
  }

  async getProxyFor(body: BodyRef, options: Omit<ProxyQuery, "body"> = {}): Promise<BodyProxy> {
    if (body.sceneId !== this.id) throw new Error("Body belongs to another scene");
    const result = await this.transport.request("scene.getProxyFor", {
      ...options, body: { sceneId: body.sceneId, id: body.id },
    });
    return { ...result, positions: new Float32Array(result.positions), normals: new Float32Array(result.normals),
      triangles: new Uint32Array(result.triangles), edgePoints: new Float32Array(result.edgePoints) };
  }

  async discardPreview(): Promise<void> {
    await this.transport.request("scene.discardPreview", { sceneId: this.id });
  }

  /** Release this scene and all its previews. Existing references become invalid. */
  async close(): Promise<void> {
    await this.transport.request("scene.close", { sceneId: this.id });
  }

  async export(options: ExportOptions): Promise<SceneFile> {
    return decode(await this.transport.request("scene.export", { ...options, sceneId: this.id }));
  }

  async capture(options: CaptureOptions): Promise<SceneFile> {
    return decode(await this.transport.request("scene.capture", { ...options, sceneId: this.id }));
  }

}

