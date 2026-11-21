import type { CircleData, CircleParameters, RectangleData, RectangleParameters, SketchData, SketchRef, SketchSupport } from "./generated/protocol.js";
import type { Transport } from "./transport.js";

export class Sketch<P extends SketchSupport = SketchSupport> {
  readonly id;
  readonly sceneId;
  readonly plane: P;
  readonly primitives;
  readonly regions;
  private readonly reference: SketchRef;

  constructor(private readonly transport: Transport, data: SketchData & { plane: P }) {
    this.id = data.id;
    this.sceneId = data.sceneId;
    this.plane = data.plane;
    this.reference = { sceneId: data.sceneId, id: data.id };
    const sketch = this.reference;
    function add(type: "rectangle", parameters: RectangleParameters): Promise<RectangleData>;
    function add(type: "circle", parameters: CircleParameters): Promise<CircleData>;
    function add(...args: ["rectangle", RectangleParameters] | ["circle", CircleParameters]) {
      const primitive = args[0] === "rectangle"
        ? { type: "rectangle" as const, parameters: args[1] }
        : { type: "circle" as const, parameters: args[1] };
      return transport.request("sketch.primitives.add", { sketch, primitive });
    }
    this.primitives = { add };
    this.regions = {
      all: () => transport.request("sketch.regions.all", { sketch: this.reference }),
      only: () => transport.request("sketch.regions.only", { sketch: this.reference }),
    };
  }

  async complete(): Promise<void> {
    await this.transport.request("sketch.complete", { sketch: this.reference });
  }

  getProxy() {
    return this.transport.request("sketch.getProxy", { sketch: this.reference });
  }
}

