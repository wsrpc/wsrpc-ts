import type { TypedProxy } from "./core.js";

export interface Deferred<T = unknown> {
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
  done: boolean;
  promise: Promise<T>;
}
export type ClientEvent = "onconnect" | "onerror" | "onclose" | "onchange";
export type ClientState = "CONNECTING" | "OPEN" | "CLOSING" | "CLOSED";
export interface BrowserProxy {
  <T = unknown>(params?: unknown): Promise<T>;
  [method: string]: BrowserProxy;
}
export interface BrowserFrame {
  readonly direction: "in" | "out";
  readonly data: string | ArrayBufferLike | ArrayBufferView | Blob;
}
export interface BrowserOptions {
  /** Receive raw payloads; observer failures are reported without affecting RPC. */
  onFrame?: (frame: BrowserFrame) => unknown;
}
export interface BrowserCallOptions {
  noWait?: boolean;
}
export interface BrowserClient<Remote extends object = never> {
  defer<T = unknown>(): Deferred<T>;
  connect(): void;
  destroy(): void;
  state(): ClientState;
  stateCode(): number;
  addEventListener(
    event: ClientEvent,
    callback: (event: Event) => unknown,
  ): number;
  removeEventListener(event: ClientEvent, index: number): boolean;
  onEvent(event: ClientEvent): Promise<Event>;
  addRoute(
    name: string,
    callback: (this: Deferred, params: any) => unknown,
    isAsync?: boolean,
  ): void;
  deleteRoute(name: string): void;
  call<T = unknown>(
    method: string,
    params?: unknown,
    options?: { noWait?: boolean },
  ): Promise<T>;
  readonly proxy: [Remote] extends [never]
    ? BrowserProxy
    : TypedProxy<Remote, BrowserCallOptions>;
  addServerEventListener(
    callback: (this: BrowserClient, event: object) => unknown,
  ): number;
  removeServerEventListener(index: number): number;
  sendRaw(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
}
declare const WSRPC: {
  DEBUG: boolean;
  TRACE: boolean;
  new <Remote extends object = never>(
    url: string,
    reconnectTimeout?: number,
    options?: BrowserOptions,
  ): BrowserClient<Remote>;
};
export default WSRPC;
