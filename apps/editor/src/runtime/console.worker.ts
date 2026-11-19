import { Core, Scene, type Transport } from "@pamatcad/sdk";

const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
let nextId = 0;
const transport: Transport = {
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: (value) => resolve(value as never), reject });
      self.postMessage({ id, method, params });
    });
  },
  close() {},
};
const core = new Core(transport);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
self.onmessage = async ({ data }) => {
  if ("id" in data) {
    const job = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) job?.reject(new Error(data.error));
    else job?.resolve(data.value);
    return;
  }
  try {
    let fn;
    try {
      fn = new AsyncFunction("core", "scene", "return (" + data.source + "\n)");
    } catch {
      fn = new AsyncFunction("core", "scene", data.source);
    }
    const value = await fn(core, new Scene(transport, data.scene));
    self.postMessage({
      output: typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "undefined"),
    });
  } catch (error) {
    self.postMessage({ failure: String(error) });
  }
};
