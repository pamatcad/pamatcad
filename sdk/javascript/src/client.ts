import type { ExtrudeFeature as WireExtrudeFeature, ExtrudeFaceSelector, ExtrudeParameters, ExtrudePreview, LineRef, ProfileRef, Profiles } from "./generated/protocol.js";
import { Body } from "./solid.js";
import { Scene } from "./scene.js";
import type { Transport } from "./transport.js";
import { WebSocketTransport } from "./transports/websocket.js";

type ExtrudeOptions = ExtrudeParameters & { targets?: Body[] };
export type ExtrudeFeature = WireExtrudeFeature & { readonly faces: ReturnType<typeof extrudeFaces> };
type FeatureFor<P extends Profiles> = ExtrudeFeature & { operation: { inputs: { profile: P } } };

function extrudeFaces(transport: Transport, feature: string) {
  function select(profile: ProfileRef, selector: ExtrudeFaceSelector) {
    const query = { feature, profile, selector };
    return {
      all: () => transport.request("solid.extrude.faces.all", query),
      only: () => transport.request("solid.extrude.faces.only", query),
    };
  }
  return {
    endCap: ({ profile }: { profile: ProfileRef }) => select(profile, { role: "endCap" }),
    startCap: ({ profile }: { profile: ProfileRef }) => select(profile, { role: "startCap" }),
    sideFaces: ({ profile, edge }: { profile: ProfileRef; edge?: LineRef }) =>
      select(profile, edge ? { role: "sideFaces", edge } : { role: "sideFaces" }),
  };
}

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
    function extrude(profile: Profiles, options: ExtrudeOptions, execution: { preview: boolean }): Promise<ExtrudeFeature | ExtrudePreview>;
    function extrude(profile: Profiles, options: ExtrudeOptions, execution?: { preview?: boolean }) {
      const { targets, ...parameters } = options;
      return transport.request("solid.extrude", {
        profile, parameters, preview: execution?.preview,
        targets: targets?.map(({ sceneId, id }) => ({ sceneId, id })),
      }).then(result => {
        if (!("id" in result)) return result;
        // Keep SDK query methods out of the serialized feature.
        return Object.defineProperty({ ...result }, "faces", { value: extrudeFaces(transport, result.id) }) as ExtrudeFeature;
      });
    }
    this.solid = { extrude };
  }

  static async connect(url: string): Promise<Core> {
    return new Core(await WebSocketTransport.connect(url));
  }

  close(): void { this.transport.close(); }
}

