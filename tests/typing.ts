import { WebSocketAsync } from "../src/index.js";
import type { RPCPeer } from "../src/index.js";
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
