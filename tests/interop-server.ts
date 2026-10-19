import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { AllowedRoute, WebSocketAsync } from "../src/index.js";

class Counter extends AllowedRoute {
  value = 0;
  init({ value }: { value: number }) {
    this.value = value;
    return this.value;
  }
  add({ value }: { value: number }) {
    this.value += value;
    return this.value;
  }
}
class RPC extends WebSocketAsync {}
RPC.addRoute("echo", (_socket, params: unknown) => params);
RPC.addRoute("counter", Counter);
RPC.addRoute("reverse", (socket, params: { value: number }) =>
  socket.call("double", params),
);
RPC.addRoute("fail", () => {
  throw new TypeError("Node failure");
});
const server = createServer();
const rpc = RPC.attach(server);
server.listen(0, "127.0.0.1", () => {
  console.log(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/`);
});
process.once("SIGTERM", () => {
  void rpc.close().then(() => server.close());
});
