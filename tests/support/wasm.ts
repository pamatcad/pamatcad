import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TestContext } from "node:test";
import { Core, CoreError, type Method, type Parameters, type Result, type Transport } from "@pamatcad/sdk";
import { captureReportScene } from "./report.js";
type WasmModule = {
  stringToNewUTF8(source: string): number;
  UTF8ToString(pointer: number): string;
  _pamatcad_execute(input: number): number;
  _pamatcad_release(result: number): void;
  _free(pointer: number): void;
};
let loaded: Promise<WasmModule> | undefined;
/** The API's sketch scenarios run unchanged against the production WASM dispatcher. */
export async function startWasmCore(t: TestContext, sceneName: string, fresh = false) {
  const load = () => import(pathToFileURL(resolve("apps/editor/public/wasm/pamatcad.mjs")).href).then(m => m.default());
  const wasm: WasmModule = await (fresh ? load() : loaded ??= load());
  const transport: Transport = {
    async request<M extends Method>(method: M, params: Parameters<M>): Promise<Result<M>> {
      const input = wasm.stringToNewUTF8(JSON.stringify({ method, params }));
      try {
        const result = wasm._pamatcad_execute(input);
        try {
          const envelope = JSON.parse(wasm.UTF8ToString(result));
          if (envelope.Err) {
            throw new CoreError(envelope.Err.message, -32000, envelope.Err);
          }
          if (envelope.Ok.method !== method) {
            throw new Error("Unexpected WASM response method");
          }
          return envelope.Ok.value;
        }
        finally {
          wasm._pamatcad_release(result);
        }
      }
      finally {
        wasm._free(input);
      }
    }, close() { },
  };
  const core = new Core(transport), scene = await core.scene.create(sceneName);
  t.after(async () => {
    try {
      if (process.env.PAMATCAD_TEST_REPORT_DIR) {
        await captureReportScene(t, scene, process.env.PAMATCAD_TEST_REPORT_DIR);
      }
    }
    finally {
      await scene.close();
      core.close();
    }
  });
  return { core, scene, url: "" };
}
