import type { SketchSupport, SceneData } from "./generated/protocol.js";
import { Sketch } from "./sketch.js";
import { Body } from "./solid.js";
import type { Transport } from "./transport.js";

export class Scene {
  readonly id;
  readonly name;
  readonly construction;
  readonly sketches;
  readonly bodies;

  constructor(transport: Transport, data: SceneData) {
    this.id = data.id;
    this.name = data.name;
    this.construction = data.construction;
    this.sketches = {
      create: async <P extends SketchSupport>(plane: P): Promise<Sketch<P>> => {
        if (plane.sceneId !== this.id) throw new Error("Sketch support belongs to another scene");
        const data = await transport.request("sketch.create", { plane });
        return new Sketch(transport, { ...data, plane: { ...plane } });
      },
    };
    this.bodies = {
      get: async (id: string): Promise<Body> => new Body(transport,
        await transport.request("body.get", { body: { sceneId: this.id, id } })),
    };
  }
}

