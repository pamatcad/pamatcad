import type { ExtrudeFeature as WireExtrudeFeature, ExtrudeFaceSelector, ExtrudeParameters, ExtrudePreview, LineRef, ProfileRef, Profiles } from "./generated/protocol.js";
import { Body } from "./solid.js";
import { Scene } from "./scene.js";
import type { Transport } from "./transport.js";
import { WebSocketTransport } from "./transports/websocket.js";

type ExtrudeOptions = ExtrudeParameters & { targets?: Body[] };
export type ExtrudeFeature = WireExtrudeFeature & { readonly faces: ReturnType<typeof extrudeFaces> };
type FeatureFor<P extends Profiles, O extends ExtrudeOptions> = Omit<ExtrudeFeature, "faces"> & {
  operation: { inputs: { profile: P } };
  faces: Omit<ExtrudeFeature["faces"], "startCap"> & (
    O extends { type: "twoSides" | "symmetric" } ? { startCap: (args: { profile: ProfileRef }) => null } :
    O extends { type: "oneSide" } ? { startCap: ExtrudeFeature["faces"]["endCap1"] } :
    "type" extends keyof O ? Pick<ExtrudeFeature["faces"], "startCap"> :
    { startCap: ExtrudeFeature["faces"]["endCap1"] }
  );
};

function extrudeFaces(transport: Transport, feature: string, twoSided: boolean) {
  function select(profile: ProfileRef, selector: ExtrudeFaceSelector) {
    const query = { feature, profile, selector };
    return {
      all: () => transport.request("solid.extrude.faces.all", query),
      only: () => transport.request("solid.extrude.faces.only", query),
    };
  }
  return {
    endCap1: ({ profile }: { profile: ProfileRef }) => select(profile, { role: "endCap1" }),
    endCap2: ({ profile }: { profile: ProfileRef }) => select(profile, { role: "endCap2" }),
    endCap: ({ profile }: { profile: ProfileRef }) => select(profile, { role: "endCap" }),
    startCap: ({ profile }: { profile: ProfileRef }) => twoSided ? null : select(profile, { role: "startCap" }),
    sideFaces: ({ profile, edge }: { profile: ProfileRef; edge?: LineRef }) =>
      select(profile, edge ? { role: "sideFaces", edge } : { role: "sideFaces" }),
    sideFaces1: ({ profile, edge }: { profile: ProfileRef; edge?: LineRef }) =>
      select(profile, edge ? { role: "sideFaces1", edge } : { role: "sideFaces1" }),
    sideFaces2: ({ profile, edge }: { profile: ProfileRef; edge?: LineRef }) =>
      select(profile, edge ? { role: "sideFaces2", edge } : { role: "sideFaces2" }),
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
    function extrude<P extends Profiles, O extends ExtrudeOptions>(profile: P, options: O, execution?: { preview?: false }): Promise<FeatureFor<P, O>>;
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
        return Object.defineProperty({ ...result }, "faces", { value: extrudeFaces(transport, result.id, (result.operation.parameters.type ?? "oneSide") !== "oneSide") }) as ExtrudeFeature;
      });
    }
    this.solid = { extrude };
  }

  static async connect(url: string): Promise<Core> {
    return new Core(await WebSocketTransport.connect(url));
  }

  close(): void { this.transport.close(); }
}

