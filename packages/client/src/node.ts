/** Node.js client and the shared ws transport adapter. */
import { AsyncLocalStorage } from "node:async_hooks";
import WebSocket from "ws";
import type { ClientOptions, RawData } from "ws";
import {
  CapacityError,
  ConnectionClosedError,
  RPCPeer,
  validateTimeout,
  setContextStorage,
} from "./core.js";
import type { InvocationContext, PeerOptions, Transport } from "./core.js";
setContextStorage(new AsyncLocalStorage<InvocationContext>());

export interface SocketOptions extends PeerOptions {
  maxBufferedBytes?: number;
  closeTimeout?: number;
}
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}
export function transport(
  socket: WebSocket,
  options: SocketOptions,
): Transport {
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
export function bind(socket: WebSocket, peer: RPCPeer): void {
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
