/** Transport-independent WSRPC protocol, routes and connection lifecycle. */
export type Params = Record<string, unknown> | readonly unknown[];
export type MaybePromise<T> = T | Promise<T>;
export type Handler<P = Params, R = unknown> = (
  this: RPCPeer,
  socket: RPCPeer,
  params: P,
) => MaybePromise<R>;
// Erasure is internal: public registration preserves the callback's parameter type.
export type RegisteredHandler =
  Handler<any, any> | (new (socket: RPCPeer) => Route) | Route;
export type Routes = ReadonlyMap<string, RegisteredHandler>;

export interface Transport {
  send(data: string | Uint8Array): MaybePromise<void>;
  close(code?: number, reason?: string): MaybePromise<void>;
}
export interface Codec {
  loads(text: string): unknown;
  dumps(value: unknown): string;
}
export interface PeerOptions {
  routes?: Routes;
  timeout?: number;
  maxPendingCalls?: number;
  maxConcurrentCalls?: number;
  context?: unknown;
  codec?: Codec;
  /** Odd IDs for a dialing client; even IDs for the accepting server. */
  client?: boolean;
}
export interface CallOptions {
  /** Milliseconds; zero disables the local timeout. */
  timeout?: number;
  signal?: AbortSignal;
}
export interface RemoteFailure {
  type: string;
  message: string;
  data?: unknown;
}
export class RemoteError extends Error {
  override name = "RemoteError";
  constructor(readonly payload: unknown) {
    super(
      isObject(payload) && typeof payload.message === "string"
        ? payload.message
        : String(payload),
    );
  }
}
export { RemoteError as ClientException };
export class ConnectionClosedError extends Error {
  override name = "ConnectionClosedError";
}
export class CallTimeoutError extends Error {
  override name = "CallTimeoutError";
}
export class CapacityError extends Error {
  override name = "CapacityError";
}

export class Signal<T> {
  private readonly listeners = new Set<(value: T) => MaybePromise<void>>();
  connect(listener: (value: T) => MaybePromise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async emit(value: T): Promise<void> {
    // Invoke every listener even if an earlier one throws synchronously.
    const results = await Promise.allSettled(
      [...this.listeners].map(async (listener) => listener(value)),
    );
    const failures = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((r) => r.reason),
        "Signal listener failed",
      );
  }
}

const masked = new WeakSet<Function>();
const exposed = new WeakSet<Function>();
/** Explicitly expose a Route method, also usable as a standard method decorator. */
export function proxy<T extends Function>(method: T): T {
  exposed.add(method);
  return method;
}
/** Mark a method as unavailable through AllowedRoute/WebSocketRoute. */
export function noproxy<T extends Function>(method: T): T {
  masked.add(method);
  return method;
}

/** Context storage is supplied by the Node transport; the core stays browser-safe. */
export interface InvocationContext {
  socket: RPCPeer;
  call?: CallEvent;
}
export interface ContextStorage {
  getStore(): InvocationContext | undefined;
  run<T>(context: InvocationContext, callback: () => T): T;
}
let contextStorage: ContextStorage | undefined;
/** @internal Install an async-local storage implementation once per runtime. */
export function setContextStorage(storage: ContextStorage): void {
  contextStorage ??= storage;
}
export function getCurrentSocket(): RPCPeer {
  const socket = contextStorage?.getStore()?.socket;
  if (!socket) throw new Error("No active RPC context");
  return socket;
}
export function getCurrentCall(): CallEvent {
  const call = contextStorage?.getStore()?.call;
  if (!call) throw new Error("No active RPC call");
  return call;
}
function inContext<T>(context: InvocationContext, callback: () => T): T {
  return contextStorage ? contextStorage.run(context, callback) : callback();
}

export class Route {
  static readonly methods: ReadonlySet<string> = new Set();
  constructor(private readonly boundSocket?: RPCPeer) {}
  /** Pre-created/shared routes resolve their socket from the current async call. */
  get socket(): RPCPeer {
    return this.boundSocket ?? getCurrentSocket();
  }
  _resolve(name: string): (...args: any[]) => unknown {
    if (!safeName(name) || name.includes("."))
      throw new Error("Method not exposed");
    const ctor = this.constructor as typeof Route;
    const actual =
      this instanceof PrefixRoute
        ? (ctor as typeof PrefixRoute).prefix + name
        : name;
    // Never resolve Object.prototype, getters, instance fields or lifecycle methods.
    let proto: object | null = Object.getPrototypeOf(this);
    while (proto && proto !== Route.prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, actual);
      if (descriptor) {
        const method: unknown = descriptor.value;
        const allowed =
          this instanceof AllowedRoute ||
          this instanceof PrefixRoute ||
          ctor.methods.has(actual) ||
          (typeof method === "function" && exposed.has(method));
        if (!allowed || typeof method !== "function" || masked.has(method))
          break;
        return method.bind(this) as (...args: any[]) => unknown;
      }
      proto = Object.getPrototypeOf(proto);
    }
    throw new Error("Method not exposed");
  }
  /** Called once when the connection closes; prefix prevents remote access. */
  _onClose(): MaybePromise<void> {}
}
export class AllowedRoute extends Route {}
export class WebSocketRoute extends AllowedRoute {}
export class PrefixRoute extends Route {
  static readonly prefix: string = "rpc_";
}

export type DynamicProxy = {
  [name: string]: DynamicProxy;
} & ((params?: Params, options?: CallOptions) => Promise<any>);
type TypedMethod<A extends unknown[], R, Options> = A extends []
  ? (params?: undefined, options?: Options) => Promise<Awaited<R>>
  : A extends [params?: unknown]
    ? (...args: [...A, options?: Options]) => Promise<Awaited<R>>
    : never;
export type TypedProxy<T, Options = CallOptions> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? TypedMethod<A, R, Options>
    : T[K] extends object
      ? TypedProxy<T[K], Options>
      : never;
};
export type RemoteProxy<T> = [T] extends [never] ? DynamicProxy : TypedProxy<T>;

export interface CallEvent {
  peer: RPCPeer;
  id: number;
  method: string;
  params: unknown;
}
export interface SuccessEvent extends CallEvent {
  result: unknown;
}
export interface FailureEvent extends CallEvent {
  error: unknown;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safeName(name: string): boolean {
  return (
    name.length > 0 &&
    name
      .split(".")
      .every(
        (part) =>
          part.length > 0 &&
          !part.startsWith("_") &&
          !["constructor", "prototype", "then"].includes(part),
      )
  );
}
function limit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1)
    throw new RangeError("Capacity must be a positive safe integer");
  return result;
}
export function validateTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError("Timeout must be finite and non-negative");
  return value;
}

export class RPCPeer {
  readonly id = crypto.randomUUID();
  readonly routes: Map<string, RegisteredHandler>;
  readonly context: unknown;
  readonly signal: AbortSignal;
  readonly proxy: DynamicProxy;
  readonly onEvent = new Signal<Record<string, unknown>>();
  readonly onBinary = new Signal<Uint8Array>();
  readonly onClose = new Signal<RPCPeer>();
  readonly onError = new Signal<unknown>();
  readonly onCallStart = new Signal<CallEvent>();
  readonly onCallSuccess = new Signal<SuccessEvent>();
  readonly onCallFail = new Signal<FailureEvent>();
  private readonly controller = new AbortController();
  private readonly pending = new Map<number, Pending>();
  private readonly active = new Set<number>();
  private readonly instances = new Map<string, Route>();
  private readonly usedInstances = new Set<Route>();
  private readonly timeout: number;
  private readonly maxPending: number;
  private readonly maxConcurrent: number;
  private readonly codec: Codec;
  private serial: number;
  private ended = false;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly transport: Transport,
    options: PeerOptions = {},
  ) {
    this.routes = new Map(options.routes);
    this.context = options.context;
    this.timeout = validateTimeout(options.timeout ?? 30_000);
    this.maxPending = limit(options.maxPendingCalls, 1024);
    this.maxConcurrent = limit(options.maxConcurrentCalls, 128);
    this.codec = options.codec ?? { loads: JSON.parse, dumps: JSON.stringify };
    this.serial = options.client ? 1 : 0;
    this.signal = this.controller.signal;
    this.proxy = this.makeProxy("");
  }
  /** Apply a remote method contract without changing protocol behavior. */
  remote<T extends object>(): TypedProxy<T> {
    return this.proxy as unknown as TypedProxy<T>;
  }
  get closed(): boolean {
    return this.ended;
  }
  get pendingCalls(): number {
    return this.pending.size;
  }
  get activeCalls(): number {
    return this.active.size;
  }
  addRoute<P, R>(
    name: string,
    handler: Handler<P, R> | (new (socket: RPCPeer) => Route) | Route,
  ): void {
    if (!safeName(name)) throw new TypeError("Invalid route name");
    this.instances.delete(name);
    this.routes.set(name, handler as RegisteredHandler);
  }
  deleteRoute(name: string): boolean {
    this.instances.delete(name);
    return this.routes.delete(name);
  }
  private makeProxy(path: string): DynamicProxy {
    return new Proxy(() => {}, {
      get: (_target, property) => {
        if (typeof property !== "string" || property === "then")
          return undefined;
        return this.makeProxy(path ? `${path}.${property}` : property);
      },
      apply: (_target, _self, args: [Params?, CallOptions?]) =>
        this.call(path, args[0], args[1]),
    }) as unknown as DynamicProxy;
  }
  async call<R = unknown>(
    method: string,
    params: unknown = {},
    options: CallOptions = {},
  ): Promise<R> {
    if (this.ended) throw new ConnectionClosedError("Connection is closed");
    if (!safeName(method)) throw new TypeError("Invalid route name");
    options.signal?.throwIfAborted();
    const timeout = validateTimeout(options.timeout ?? this.timeout);
    if (this.pending.size >= this.maxPending)
      throw new CapacityError("Too many pending calls");
    if (this.serial > Number.MAX_SAFE_INTEGER - 2)
      throw new CapacityError("Call identifiers exhausted");
    this.serial += 2;
    const id = this.serial;
    return new Promise<R>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error: unknown) => {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        item.cleanup();
        reject(error);
      };
      const abort = () => finish(options.signal?.reason);
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, {
        resolve: (value) => resolve(value as R),
        reject,
        cleanup,
      });
      if (timeout)
        timer = setTimeout(
          () => finish(new CallTimeoutError(`RPC call timed out: ${method}`)),
          timeout,
        );
      options.signal?.addEventListener("abort", abort, { once: true });
      void this.send({ id, method, params }).catch(finish);
    });
  }
  async emit(event: Record<string, unknown>): Promise<void> {
    if (Object.hasOwn(event, "id"))
      throw new TypeError("Events must not contain an id");
    await this.send(event);
  }
  async sendRaw(data: string | Uint8Array): Promise<void> {
    if (this.ended) throw new ConnectionClosedError("Connection is closed");
    await this.transport.send(data);
  }
  private async send(frame: unknown): Promise<void> {
    await this.sendRaw(this.codec.dumps(frame));
  }
  private async notify<T>(signal: Signal<T>, value: T): Promise<void> {
    try {
      await signal.emit(value);
    } catch (error) {
      try {
        await this.onError.emit(error);
      } catch {
        /* Error listeners cannot break protocol cleanup. */
      }
    }
  }
  /** Dispatch independently: a handler waiting for a reverse call must not block replies. */
  async receive(data: string | Uint8Array, binary = false): Promise<void> {
    if (this.ended) return;
    if (binary) {
      await this.notify(
        this.onBinary,
        typeof data === "string" ? new TextEncoder().encode(data) : data,
      );
      return;
    }
    let message: Record<string, unknown>;
    try {
      const parsed = this.codec.loads(
        typeof data === "string"
          ? data
          : new TextDecoder("utf-8", { fatal: true }).decode(data),
      );
      if (!isObject(parsed)) throw new TypeError("Expected a JSON object");
      message = parsed;
    } catch (error) {
      await this.notify(this.onError, error);
      await this.close(1007, "Invalid RPC message");
      return;
    }
    if (!Object.hasOwn(message, "id")) {
      await this.notify(this.onEvent, message);
      return;
    }
    const id = message.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      await this.close(1008, "Invalid RPC identifier");
      return;
    }
    if (Object.hasOwn(message, "method")) {
      if (
        typeof message.method !== "string" ||
        Object.hasOwn(message, "result") ||
        Object.hasOwn(message, "error")
      ) {
        await this.close(1008, "Invalid RPC request");
        return;
      }
      if (this.active.has(id)) {
        await this.close(1008, "Duplicate RPC identifier");
        return;
      }
      if (this.active.size >= this.maxConcurrent) {
        await this.send({
          id,
          error: { type: "CapacityError", message: "Too many active calls" },
        });
        return;
      }
      this.active.add(id);
      await this.dispatch(id, message.method, message.params ?? {});
      return;
    }
    const item = this.pending.get(id);
    if (!item) return; // Late replies after local timeout/abort are harmless.
    this.pending.delete(id);
    item.cleanup();
    if (Object.hasOwn(message, "error"))
      item.reject(new RemoteError(message.error));
    else item.resolve(Object.hasOwn(message, "result") ? message.result : null);
  }
  private resolve(method: string): (params: unknown) => unknown {
    if (!safeName(method)) throw new Error("Method not exposed");
    const dot = method.indexOf(".");
    const root = dot < 0 ? method : method.slice(0, dot);
    const handler = this.routes.get(root);
    if (
      handler instanceof Route ||
      (typeof handler === "function" && handler.prototype instanceof Route)
    ) {
      let route = this.instances.get(root);
      if (!route) {
        route =
          handler instanceof Route
            ? handler
            : new (handler as new (socket: RPCPeer) => Route)(this);
        this.instances.set(root, route);
        this.usedInstances.add(route);
      }
      const fn = route._resolve(dot < 0 ? "init" : method.slice(dot + 1));
      return (params) => fn(params);
    }
    const fn = this.routes.get(method);
    if (typeof fn === "function" && !(fn.prototype instanceof Route))
      return (params) => (fn as Handler<unknown>).call(this, this, params);
    if (method === "ping") return (params) => params;
    throw new Error("Method not exposed");
  }
  private async dispatch(
    id: number,
    method: string,
    params: unknown,
  ): Promise<void> {
    const event = { peer: this, id, method, params };
    return inContext({ socket: this, call: event }, async () => {
      try {
        await this.notify(this.onCallStart, event);
        if (this.ended) return;
        const result = await this.resolve(method)(params);
        if (!this.ended)
          await this.send({ id, result: result === undefined ? null : result });
        await this.notify(this.onCallSuccess, { ...event, result });
      } catch (error) {
        await this.notify(this.onCallFail, { ...event, error });
        const payload: RemoteFailure = {
          type: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        };
        if (!this.ended) {
          try {
            await this.send({ id, error: payload });
          } catch (sendError) {
            await this.notify(this.onError, sendError);
            await this.close(1011, "Transport failure");
          }
        }
      } finally {
        this.active.delete(id);
      }
    });
  }
  /** Reject outstanding calls immediately; handlers can observe socket.signal. */
  close(code = 1000, reason = "RPC connection closed"): Promise<void> {
    if (this.closing) return this.closing;
    this.ended = true;
    const error = new ConnectionClosedError(reason);
    this.controller.abort(error);
    for (const item of this.pending.values()) {
      item.cleanup();
      item.reject(error);
    }
    this.pending.clear();
    this.active.clear();
    this.closing = inContext({ socket: this }, () =>
      this.finishClose(code, reason),
    );
    return this.closing;
  }
  private async finishClose(code: number, reason: string): Promise<void> {
    try {
      await this.transport.close(code, reason);
    } catch (error) {
      await this.notify(this.onError, error);
    }
    for (const instance of this.usedInstances) {
      try {
        await inContext({ socket: this }, () => instance._onClose());
      } catch (error) {
        await this.notify(this.onError, error);
      }
    }
    this.instances.clear();
    this.usedInstances.clear();
    await this.notify(this.onClose, this);
  }
}
