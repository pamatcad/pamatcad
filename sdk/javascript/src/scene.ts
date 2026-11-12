import type { CaptureScene, EncodedFile, ExportScene, SketchSupport, SceneData } from "./generated/protocol.js";
import { Sketch } from "./sketch.js";
import { Body } from "./solid.js";
import type { Transport } from "./transport.js";

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
  readonly sketches;
  readonly bodies;
  readonly timeline;

  constructor(private readonly transport: Transport, data: SceneData) {
    this.id = data.id;
    this.name = data.name;
    this.construction = data.construction;
    this.timeline = { list: () => transport.request("scene.timeline.list", { sceneId: this.id }) };
    this.sketches = {
      create: async <P extends SketchSupport>(plane: P): Promise<Sketch<P>> => {
        if (plane.sceneId !== this.id) throw new Error("Sketch support belongs to another scene");
        const data = await transport.request("sketch.create", { plane });
        return new Sketch(transport, { ...data, plane: { ...plane } });
      },
    };
    this.bodies = {
      all: () => transport.request("scene.bodies.all", { sceneId: this.id }),
      get: async (id: string): Promise<Body> => new Body(transport,
        await transport.request("body.get", { body: { sceneId: this.id, id } })),
    };
  }
  async export(options: ExportOptions): Promise<SceneFile> {
    return decode(await this.transport.request("scene.export", { ...options, sceneId: this.id }));
  }

  async capture(options: CaptureOptions): Promise<SceneFile> {
    return decode(await this.transport.request("scene.capture", { ...options, sceneId: this.id }));
  }

}

