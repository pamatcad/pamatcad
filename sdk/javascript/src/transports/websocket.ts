import type { CoreError as ErrorData } from "../generated/protocol.js";
import type { Method, Parameters, Result, Transport } from "../transport.js";

export class CoreError extends Error {
  constructor(
    message: string,
    readonly rpcCode: number,
    readonly details?: ErrorData,
  ) {
    super(message);
    this.name = "CoreError";
  }
}

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

type RpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: ErrorData };
};

export class WebSocketTransport implements Transport {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      try {
        if (typeof event.data !== "string") throw new Error("Expected a JSON-RPC text response");
        const message = JSON.parse(event.data) as RpcResponse;
        if (message.jsonrpc !== "2.0" || typeof message.id !== "number") {
          throw new Error("Invalid JSON-RPC response");
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new CoreError(message.error.message, message.error.code, message.error.data));
        } else if (Object.hasOwn(message, "result")) {
          pending.resolve(message.result);
        } else {
          pending.reject(new Error("JSON-RPC response has no result or error"));
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        socket.close();
      }
    });
    socket.addEventListener("close", () => this.fail(new Error("Core connection closed")));
    socket.addEventListener("error", () => this.fail(new Error("Core connection failed")));
  }

  static connect(url: string): Promise<WebSocketTransport> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
      };
      const opened = () => { cleanup(); resolve(new WebSocketTransport(socket)); };
      const failed = () => { cleanup(); reject(new Error(`Could not connect to ${url}`)); };
      const timer = setTimeout(() => {
        cleanup();
        socket.close();
        reject(new Error(`Connection to ${url} timed out`));
      }, 10_000);
      socket.addEventListener("open", opened);
      socket.addEventListener("error", failed);
      socket.addEventListener("close", failed);
    });
  }

  request<M extends Method>(method: M, parameters: Parameters<M>): Promise<Result<M>> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Core is not connected"));
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out; its completion status is unknown`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: parameters }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    }) as Promise<Result<M>>;
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close(): void {
    this.fail(new Error("Core connection closed"));
    this.socket.close();
  }
}

