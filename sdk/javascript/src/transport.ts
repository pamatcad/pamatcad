import type { Request, Response } from "./generated/protocol.js";

export type Method = Request["method"];
export type Parameters<M extends Method> = Extract<Request, { method: M }>["params"];
export type Result<M extends Method> = Extract<Response, { method: M }>["value"];

export interface Transport {
  request<M extends Method>(method: M, parameters: Parameters<M>): Promise<Result<M>>;
  close(): void;
}

