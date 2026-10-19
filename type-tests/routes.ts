import { WebSocketAsync } from "@wsrpc/server";
import type { RPCPeer } from "@wsrpc/server";
interface Remote {
  counter: { add(params: { value: number }): number };
}
export function contracts(peer: RPCPeer) {
  const proxy = peer.remote<Remote>();
  const value: Promise<number> = proxy.counter.add({ value: 1 });
  // @ts-expect-error remote arguments are checked
  void proxy.counter.add({ value: "bad" });
  // @ts-expect-error unknown remote methods are checked
  void proxy.unknown({});
  return value;
}
class RPC extends WebSocketAsync {}
RPC.addRoute("add", (_socket, { a, b }: { a: number; b: number }) => a + b);
// @ts-expect-error non-callable routes are rejected
RPC.addRoute("bad", {});

import WSRPC from "@wsrpc/client";
import { AllowedRoute, getCurrentSocket } from "@wsrpc/server";
const browser = new WSRPC("ws://localhost/ws/", 1000);
const echoed: Promise<{ value: number }> = browser.call("echo", { value: 1 });
void echoed;
browser.addRoute("double", ({ value }: { value: number }) => value * 2);
class Injected extends AllowedRoute {
  constructor(readonly dependency: { name: string }) {
    super();
  }
  method() {
    return this.socket.id + this.dependency.name;
  }
}
RPC.addRoute("injected", new Injected({ name: "ready" }));
RPC.addRoute("contextual", function (_socket, params: { value: number }) {
  const peer: RPCPeer = this;
  return { value: params.value, same: peer === getCurrentSocket() };
});

import type { BrowserOptions, BrowserFrame } from "@wsrpc/client";
import type { NWsRPC } from "@wsrpc/client/wsrpc.d.ts";
const options: BrowserOptions = {
  onFrame(frame) {
    const direction: "in" | "out" = frame.direction;
    if (typeof frame.data === "string") JSON.parse(frame.data);
    // @ts-expect-error observer metadata is read-only
    frame.direction = "out";
    void direction;
  },
};
new WSRPC("ws://localhost/ws/", 1000, options);
// @ts-expect-error unsupported observer option
new WSRPC("ws://localhost/ws/", 1000, { codec: {} });
export function legacyConstructor(Client: NWsRPC.Main.WSRPC) {
  return new Client("ws://localhost/ws/", 1000, {
    onFrame(frame) {
      const compatible: BrowserFrame = frame;
      void compatible;
    },
  });
}

// Existing untyped JavaScript proxy calls can use the legacy noWait option.
const optionalCall: Promise<number> = browser.proxy.counter!.add!<number>(
  { value: 1 },
  { noWait: true },
);
const connected: Promise<void> = browser.onEvent("onconnect");
void optionalCall;
void connected;
