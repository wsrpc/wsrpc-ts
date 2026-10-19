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
