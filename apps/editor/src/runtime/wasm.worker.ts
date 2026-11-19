interface Module {
  stringToNewUTF8(text: string): number;
  UTF8ToString(ptr: number): string;
  _pamatcad_execute(input: number): number;
  _pamatcad_release(result: number): void;
  _free(input: number): void;
}

let moduleReady: Promise<Module>;
self.onmessage = async ({ data }) => {
  try {
    if (data.moduleUrl) {
      moduleReady = import(/* @vite-ignore */ data.moduleUrl).then((m) => m.default());
      await moduleReady;
      return;
    }
    const wasm = await moduleReady;
    const input = wasm.stringToNewUTF8(JSON.stringify(data.request));
    try {
      const result = wasm._pamatcad_execute(input);
      try {
        const envelope = JSON.parse(wasm.UTF8ToString(result));
        self.postMessage({ id: data.id, response: envelope.Ok, error: envelope.Err });
      } finally {
        wasm._pamatcad_release(result);
      }
    } finally {
      wasm._free(input);
    }
  } catch (error) {
    self.postMessage({ id: data.id, error: { message: String(error) } });
  }
};
