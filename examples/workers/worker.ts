import { RPCPeer } from "@wsrpc/client/core";

export default {
  fetch(request: Request): Response {
    if (new URL(request.url).pathname !== "/ws/")
      return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0],
      server = pair[1];
    server.binaryType = "arraybuffer";
    server.accept();
    const peer = new RPCPeer({
      send(data) {
        server.send(data);
      },
      close(code, reason) {
        server.close(code, reason);
      },
    });
    peer.addRoute("echo", (_socket, params: unknown) => params);
    peer.addRoute("callback", (socket, params: { value: number }) =>
      socket.call("double", params),
    );
    server.addEventListener("message", (event) => {
      const binary = typeof event.data !== "string";
      const data =
        typeof event.data === "string"
          ? event.data
          : new Uint8Array(event.data);
      void peer
        .receive(data, binary)
        .catch(() => peer.close(1011, "RPC dispatch failed"));
    });
    server.addEventListener("close", () => {
      void peer.close();
    });
    server.addEventListener("error", () => {
      void peer.close(1011, "WebSocket error");
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
