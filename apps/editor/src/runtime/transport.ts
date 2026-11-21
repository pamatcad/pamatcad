import { CoreError, type Method, type Parameters, type Result, type Transport } from "@pamatcad/sdk";

type Response = { method: Method; value: unknown };
type Pending = { resolve(value: Response): void; reject(error: Error): void };
type Dispatch = (method: Method, params: unknown) => Promise<Response>;

export function editorTransport(onCommand: (method: Method, params: unknown) => void | ((elapsedMs: number) => void)): Transport {
  let dispatch: Dispatch;
  let close = () => {};
  if (import.meta.env.MODE === "desktop") {
    dispatch = async (method, params) => {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        return await invoke<Response>("execute", { request: { method, params } });
      } catch (failure) {
        if (failure && typeof failure === "object" && "message" in failure) {
          throw new CoreError(String(failure.message), -32000, failure as NonNullable<CoreError["details"]>);
        }
        throw new Error(String(failure));
      }
    };
  } else {
    const worker = new Worker(new URL("./wasm.worker.ts", import.meta.url), { type: "module" });
    const pending = new Map<number, Pending>();
    let next = 0;
    let stopped: Error | undefined;
    function stop(error: Error) {
      stopped = error;
      for (const job of pending.values()) job.reject(error);
      pending.clear();
      worker.terminate();
    }
    worker.onerror = (event) => stop(new Error(event.message || "CAD worker stopped"));
    worker.onmessageerror = () => stop(new Error("Unreadable message from the CAD worker"));
    worker.onmessage = ({ data }) => {
      if (data.id === undefined && data.error) return stop(new Error(data.error.message));
      const job = pending.get(data.id);
      if (!job) return;
      pending.delete(data.id);
      if (data.error) job.reject(new CoreError(data.error.message, -32000, data.error));
      else job.resolve(data.response);
    };
    worker.postMessage({ moduleUrl: new URL("wasm/pamatcad.mjs", document.baseURI).href });
    dispatch = (method, params) =>
      new Promise((resolve, reject) => {
        if (stopped) return reject(stopped);
        const id = ++next;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, request: { method, params } });
      });
    close = () => stop(new Error("CAD worker closed"));
  }
  return {
    async request<M extends Method>(method: M, params: Parameters<M>): Promise<Result<M>> {
      const finish = onCommand(method, params);
      const started = performance.now();
      try {
        const result = await dispatch(method, params);
        if (result.method !== method) throw new Error("Unexpected CAD response");
        return result.value as Result<M>;
      } finally {
        finish?.(performance.now() - started);
      }
    },
    close,
  };
}
