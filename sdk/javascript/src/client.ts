import type { ExtrudeFeature, ExtrudeParameters, ExtrudePreview, ExtrudeResult, Profiles } from "./generated/protocol.js";
import { Body } from "./solid.js";
import { Scene } from "./scene.js";
import type { Transport } from "./transport.js";
import { WebSocketTransport } from "./transports/websocket.js";

type ExtrudeOptions = ExtrudeParameters & { targets?: Body[] };
type FeatureFor<P extends Profiles> = ExtrudeFeature & { operation: { inputs: { profile: P } } };

export class Core {
  readonly scene;
  readonly solid;

  constructor(private readonly transport: Transport) {
    this.scene = {
      create: async (name: string | null = null): Promise<Scene> =>
        new Scene(transport, await transport.request("scene.create", { name })),
    };
    function extrude<P extends Profiles>(profile: P, options: ExtrudeOptions, execution?: { preview?: false }): Promise<FeatureFor<P>>;
    function extrude(profile: Profiles, options: ExtrudeOptions, execution: { preview: true }): Promise<ExtrudePreview>;
    function extrude(profile: Profiles, options: ExtrudeOptions, execution: { preview: boolean }): Promise<ExtrudeResult>;
    function extrude(profile: Profiles, options: ExtrudeOptions, execution?: { preview?: boolean }) {
      const { targets, ...parameters } = options;
      return transport.request("solid.extrude", {
        profile, parameters, preview: execution?.preview,
        targets: targets?.map(({ sceneId, id }) => ({ sceneId, id })),
      });
    }
    this.solid = { extrude };
  }

  static async connect(url: string): Promise<Core> {
    return new Core(await WebSocketTransport.connect(url));
  }

  close(): void { this.transport.close(); }
}

