import type { ExtrudeParameters, RegionRef } from "./generated/protocol.js";
import { Body } from "./solid.js";
import { Scene } from "./scene.js";
import type { Transport } from "./transport.js";
import { WebSocketTransport } from "./transports/websocket.js";

export class Core {
  readonly scene;
  readonly solid;

  constructor(private readonly transport: Transport) {
    this.scene = {
      create: async (name: string | null = null): Promise<Scene> =>
        new Scene(transport, await transport.request("scene.create", { name })),
    };
    this.solid = {
      extrude: (profile: RegionRef, options: ExtrudeParameters & { targets?: Body[] }) => {
        const { targets, ...parameters } = options;
        return transport.request("solid.extrude", {
          profile, parameters, targets: targets?.map(({ sceneId, id }) => ({ sceneId, id })),
        });
      },
    };
  }

  static async connect(url: string): Promise<Core> {
    return new Core(await WebSocketTransport.connect(url));
  }

  close(): void { this.transport.close(); }
}

