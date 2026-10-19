/** Node HTTP upgrade and ws adapters. The protocol lives in ./core. */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import type { ClientOptions, RawData } from "ws";
import {
  CapacityError,
  ConnectionClosedError,
  RPCPeer,
  Signal,
  validateTimeout,
} from "./core.js";
import type {
  Handler,
  PeerOptions,
  RegisteredHandler,
  Route,
  Routes,
  Transport,
} from "./core.js";

export interface SocketOptions extends PeerOptions {
  maxBufferedBytes?: number;
  closeTimeout?: number;
}
export interface ServerOptions extends SocketOptions {
  path?: string;
  maxPayload?: number;
  authorizationTimeout?: number;
  /** false denies the upgrade; otherwise the result becomes socket.context. */
  authorize?: (
    request: IncomingMessage,
    signal: AbortSignal,
  ) => unknown | Promise<unknown>;
}
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}
function transport(socket: WebSocket, options: SocketOptions): Transport {
  const maxBuffered = positive(
    options.maxBufferedBytes ?? 1_048_576,
    "maxBufferedBytes",
  );
  const closeTimeout = validateTimeout(options.closeTimeout ?? 1000);
  return {
    send(data) {
      if (socket.readyState !== WebSocket.OPEN)
        throw new ConnectionClosedError("WebSocket is not open");
      if (socket.bufferedAmount + Buffer.byteLength(data) > maxBuffered)
        throw new CapacityError("WebSocket send buffer is full");
      return new Promise<void>((resolve, reject) =>
        socket.send(data, (error) => (error ? reject(error) : resolve())),
      );
    },
    close(code, reason) {
      if (socket.readyState === WebSocket.CLOSED) return;
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
        return;
      }
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
      const timer = setTimeout(() => socket.terminate(), closeTimeout);
      timer.unref();
      socket.once("close", () => clearTimeout(timer));
    },
  };
}
function bytes(data: RawData): Buffer {
  return Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.from(data as ArrayBuffer);
}
function bind(socket: WebSocket, peer: RPCPeer): void {
  const message = (data: RawData, binary: boolean) => {
    void peer.receive(bytes(data), binary).catch(async (error) => {
      try {
        await peer.onError.emit(error);
      } catch {
        /* Reporters must not leak promises. */
      }
      await peer.close(1011, "RPC dispatch failed");
    });
  };
  const error = (cause: Error) => {
    void peer.onError.emit(cause).catch(() => {});
    void peer.close(1011, "WebSocket error");
  };
  socket.on("message", message);
  socket.on("error", error);
  socket.once("close", () => {
    socket.off("message", message);
    socket.off("error", error);
    void peer.close();
  });
}

export class RPCServer {
  readonly clients = new Map<string, RPCPeer>();
  readonly onConnect = new Signal<RPCPeer>();
  readonly onDisconnect = new Signal<RPCPeer>();
  readonly onError = new Signal<unknown>();
  private readonly sockets = new Set<WebSocket>();
  private readonly authorizing = new Map<Duplex, AbortController>();
  private readonly wss: WebSocketServer;
  private readonly routes: Routes;
  private attached: Server | undefined;
  private closing: Promise<void> | undefined;
  private ended = false;
  private readonly authorizationTimeout: number;
  constructor(private readonly options: ServerOptions = {}) {
    this.routes = new Map(options.routes);
    this.authorizationTimeout = validateTimeout(
      options.authorizationTimeout ?? 10_000,
    );
    if (options.path !== undefined && !options.path.startsWith("/"))
      throw new TypeError("path must start with /");
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: positive(options.maxPayload ?? 1_048_576, "maxPayload"),
    });
    this.wss.on("error", (error) => {
      void this.report(error);
    });
    // Validate before the first upgrade rather than leaving an open unbound socket.
    if (options.maxBufferedBytes !== undefined)
      positive(options.maxBufferedBytes, "maxBufferedBytes");
    validateTimeout(options.closeTimeout ?? 1000);
    validateTimeout(options.timeout ?? 30_000);
    for (const key of ["maxPendingCalls", "maxConcurrentCalls"] as const) {
      if (options[key] !== undefined) positive(options[key], key);
    }
  }
  private async report(error: unknown): Promise<void> {
    try {
      await this.onError.emit(error);
    } catch {
      /* Terminal error sink. */
    }
  }
  attach(server: Server): this {
    if (this.ended || this.attached)
      throw new Error("RPC server is closed or already attached");
    this.attached = server;
    server.on("upgrade", this.upgrade);
    return this;
  }
  /** Unmatched paths are left to other upgrade listeners on the HTTP server. */
  private readonly upgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    let path: string;
    try {
      path = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (path !== (this.options.path ?? "/ws/")) return;
    if (this.ended) {
      socket.destroy();
      return;
    }
    void this.accept(request, socket, head);
  };
  private async accept(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const controller = new AbortController();
    this.authorizing.set(socket, controller);
    const disconnected = () =>
      controller.abort(new ConnectionClosedError("Upgrade disconnected"));
    socket.once("close", disconnected);
    // Raw socket errors before ws owns the socket must be consumed.
    const rawError = () =>
      controller.abort(new ConnectionClosedError("Upgrade failed"));
    socket.on("error", rawError);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason),
          { once: true },
        );
      });
      if (this.authorizationTimeout)
        timer = setTimeout(
          () => controller.abort(new Error("Authorization timed out")),
          this.authorizationTimeout,
        );
      const context = await Promise.race([
        Promise.resolve().then(() =>
          this.options.authorize
            ? this.options.authorize(request, controller.signal)
            : this.options.context,
        ),
        aborted,
      ]);
      if (this.ended || socket.destroyed) return;
      if (context === false) {
        socket.end(
          "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.serve(ws, { context });
      });
    } catch (error) {
      await this.report(error);
      if (!socket.destroyed) socket.destroy();
    } finally {
      clearTimeout(timer);
      this.authorizing.delete(socket);
      socket.off("close", disconnected);
      socket.off("error", rawError);
    }
  }
  /** Bind an already accepted ws socket, e.g. one provided by a framework. */
  serve(socket: WebSocket, options: SocketOptions = {}): RPCPeer {
    if (this.ended) throw new ConnectionClosedError("RPC server is closed");
    if (this.sockets.has(socket)) throw new Error("WebSocket is already bound");
    if (socket.readyState !== WebSocket.OPEN)
      throw new ConnectionClosedError("Expected an open WebSocket");
    const settings = {
      ...this.options,
      ...options,
      routes: this.routes,
      client: false,
    };
    const peer = new RPCPeer(transport(socket, settings), settings);
    bind(socket, peer);
    this.clients.set(peer.id, peer);
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    peer.onError.connect((error) => this.report(error));
    peer.onClose.connect(async () => {
      this.clients.delete(peer.id);
      try {
        await this.onDisconnect.emit(peer);
      } catch (error) {
        await this.report(error);
      }
    });
    void this.onConnect.emit(peer).catch((error) => this.report(error));
    return peer;
  }
  async broadcast(
    method: string,
    params: unknown = {},
    options = {},
  ): Promise<PromiseSettledResult<unknown>[]> {
    return Promise.allSettled(
      [...this.clients.values()].map((peer) =>
        peer.call(method, params, options),
      ),
    );
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.ended = true;
    this.attached?.off("upgrade", this.upgrade);
    for (const [socket, controller] of this.authorizing) {
      controller.abort(new ConnectionClosedError("Server shutdown"));
      socket.destroy();
    }
    this.closing = (async () => {
      await Promise.all(
        [...this.clients.values()].map((peer) =>
          peer.close(1001, "Server shutdown"),
        ),
      );
      await new Promise<void>((resolve) => this.wss.close(() => resolve()));
      // Also cover externally accepted sockets which are not tracked by wss.
      for (const socket of this.sockets) socket.terminate();
      this.sockets.clear();
    })();
    return this.closing;
  }
}

const registries = new WeakMap<Function, Map<string, RegisteredHandler>>();
function registry(
  handler: typeof WebSocketAsync,
): Map<string, RegisteredHandler> {
  let own = registries.get(handler);
  if (!own) {
    const parent = Object.getPrototypeOf(handler) as typeof WebSocketAsync;
    own = new Map(
      parent && parent !== Function.prototype ? registry(parent) : [],
    );
    registries.set(handler, own);
  }
  return own;
}
/** Subclass to keep route registrations separate, like Python WebSocketAsync. */
export class WebSocketAsync {
  static addRoute<P, R>(
    name: string,
    handler: Handler<P, R> | (new (socket: RPCPeer) => Route),
  ): void {
    if (
      !name ||
      name
        .split(".")
        .some(
          (part) =>
            !part ||
            part.startsWith("_") ||
            ["constructor", "prototype", "then"].includes(part),
        )
    )
      throw new TypeError("Invalid route name");
    registry(this).set(name, handler as RegisteredHandler);
  }
  static deleteRoute(name: string): boolean {
    return registry(this).delete(name);
  }
  static asServer(options: ServerOptions = {}): RPCServer {
    return new RPCServer({ ...options, routes: registry(this) });
  }
  static attach(server: Server, options: ServerOptions = {}): RPCServer {
    return this.asServer(options).attach(server);
  }
}

export interface ConnectOptions extends SocketOptions {
  websocket?: ClientOptions;
}
export class WSRPCClient extends RPCPeer {
  private constructor(
    readonly webSocket: WebSocket,
    options: SocketOptions,
  ) {
    super(transport(webSocket, options), { ...options, client: true });
    bind(webSocket, this);
  }
  static connect(
    url: string | URL,
    options: ConnectOptions = {},
  ): Promise<WSRPCClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        ...options.websocket,
        handshakeTimeout: options.websocket?.handshakeTimeout ?? 10_000,
      });
      const failed = (error: Error) => reject(error);
      socket.once("error", failed);
      socket.once("open", () => {
        socket.off("error", failed);
        try {
          resolve(new WSRPCClient(socket, options));
        } catch (error) {
          socket.on("error", () => {});
          socket.terminate();
          reject(error);
        }
      });
      socket.once("close", () =>
        reject(new ConnectionClosedError("Connection failed")),
      );
    });
  }
}
