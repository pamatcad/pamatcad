import type { BodyRef, FaceOrigin, FaceRef } from "./generated/protocol.js";
import type { Transport } from "./transport.js";

export class Body {
  readonly id;
  readonly sceneId;
  readonly faces;
  readonly vertices;

  constructor(private readonly transport: Transport, private readonly reference: BodyRef) {
    this.id = reference.id;
    this.sceneId = reference.sceneId;
    this.vertices={all:()=>transport.request("body.vertices.all",{body:reference})};
    function query(filter: { origin: FaceOrigin }): { only(): Promise<Extract<FaceRef, { origin: FaceOrigin }>> };
    function query(filter: { normal: [number, number, number] }): { only(): Promise<Extract<FaceRef, { faceId: number }>> };
    function query(filter: { origin: FaceOrigin } | { normal: [number, number, number] }) {
      return { only: () => transport.request("body.faces.only", { body: reference, ...filter }) };
    }
    this.faces = { query, properties: (face: FaceRef) => {
      if (face.sceneId !== reference.sceneId || face.bodyId !== reference.id) throw new Error("Face belongs to another body");
      return transport.request("face.properties", face);
    }, all: () => transport.request("body.faces.all", { body: reference }) };
  }

  /** Tessellate the current body in world coordinates (millimetres). */
  mesh() {
    return this.transport.request("body.mesh", { body: this.reference });
  }

  properties() {
    return this.transport.request("body.properties", { body: this.reference });
  }
}

