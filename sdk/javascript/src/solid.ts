import type { BodyRef, FaceOrigin } from "./generated/protocol.js";
import type { Transport } from "./transport.js";

export class Body {
  readonly id;
  readonly sceneId;
  readonly faces;

  constructor(private readonly transport: Transport, private readonly reference: BodyRef) {
    this.id = reference.id;
    this.sceneId = reference.sceneId;
    this.faces = {
      query: ({ origin }: { origin: FaceOrigin }) => ({
        only: () => transport.request("body.faces.only", { body: reference, origin }),
      }),
    };
  }

  properties() {
    return this.transport.request("body.properties", { body: this.reference });
  }
}

