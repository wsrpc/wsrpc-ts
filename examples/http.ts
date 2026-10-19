import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketAsync } from "@wsrpc/server";

class RPC extends WebSocketAsync {}
RPC.addRoute("echo", (_socket, params: Record<string, unknown>) => params);
RPC.addRoute("callback", (socket, { value }: { value: number }) =>
  socket.call<number>("double", { value }),
);

export function createApp() {
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/health" ? 200 : 404, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify(
        request.url === "/health" ? { ok: true } : { error: "Not found" },
      ),
    );
  });
  const rpc = RPC.attach(server, { path: "/ws/" });
  return { server, rpc };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { server, rpc } = createApp();
  server.listen(Number(process.env.PORT ?? 8000), "127.0.0.1");
  process.once("SIGINT", () => {
    void rpc.close().then(() => server.close());
  });
}
