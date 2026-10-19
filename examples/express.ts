import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import express from "express";
import { WebSocketAsync } from "@wsrpc/server";

class RPC extends WebSocketAsync {}
RPC.addRoute("echo", (_socket, params: Record<string, unknown>) => params);
RPC.addRoute("callback", (socket, { value }: { value: number }) =>
  socket.call<number>("double", { value }),
);

export function createApp() {
  const app = express();
  app.get("/health", (_request, response) => {
    response.json({ ok: true });
  });
  const server = createServer(app);
  const rpc = RPC.attach(server, { path: "/ws/" });
  return { app, server, rpc };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { server, rpc } = createApp();
  server.listen(Number(process.env.PORT ?? 8000), "127.0.0.1");
  process.once("SIGINT", () => {
    void rpc.close().then(() => server.close());
  });
}
