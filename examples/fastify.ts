import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { WebSocketAsync } from "@wsrpc/server";

class RPC extends WebSocketAsync {}
RPC.addRoute("echo", (_socket, params: Record<string, unknown>) => params);
RPC.addRoute("callback", (socket, { value }: { value: number }) =>
  socket.call<number>("double", { value }),
);

export function createApp() {
  const app = Fastify();
  app.get("/health", async () => ({ ok: true }));
  const rpc = RPC.attach(app.server, { path: "/ws/" });
  app.addHook("preClose", async () => {
    await rpc.close();
  });
  return { app, rpc };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { app } = createApp();
  await app.listen({
    port: Number(process.env.PORT ?? 8000),
    host: "127.0.0.1",
  });
  process.once("SIGINT", () => {
    void app.close();
  });
}
