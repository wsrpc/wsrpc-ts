import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketAsync, WSRPCClient } from "../src/index.js";
import type { ServerOptions } from "../src/index.js";

export async function fixture(
  RPC: typeof WebSocketAsync,
  options: ServerOptions = {},
) {
  const server = createServer((_req, res) => res.end("HTTP works"));
  const rpc = RPC.attach(server, options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/`;
  return {
    rpc,
    server,
    url,
    connect: () => WSRPCClient.connect(url),
    close: async () => {
      await rpc.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
export const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
