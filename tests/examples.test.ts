import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createApp as nodeApp } from "../examples/http.js";
import { createApp as expressApp } from "../examples/express.js";
import { createApp as fastifyApp } from "../examples/fastify.js";
import { WSRPCClient } from "../src/index.js";

for (const [name, factory] of [
  ["Node HTTP", nodeApp],
  ["Express", expressApp],
] as const) {
  test(`${name} example serves HTTP and bidirectional RPC`, async () => {
    const { server, rpc } = factory();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    try {
      const http = await fetch(`http://127.0.0.1:${port}/health`);
      assert.deepEqual(await http.json(), { ok: true });
      const c = await WSRPCClient.connect(`ws://127.0.0.1:${port}/ws/`, {
        routes: new Map([
          ["double", (_socket, { value }: { value: number }) => value * 2],
        ]),
      });
      assert.deepEqual(await c.call("echo", { message: "Hello" }), {
        message: "Hello",
      });
      assert.equal(await c.call("callback", { value: 21 }), 42);
    } finally {
      await rpc.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
test("Fastify example serves HTTP and bidirectional RPC, closes active sockets", async () => {
  const { app } = fastifyApp();
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  try {
    assert.deepEqual(await (await fetch(base + "/health")).json(), {
      ok: true,
    });
    const c = await WSRPCClient.connect(base.replace("http:", "ws:") + "/ws/", {
      routes: new Map([
        ["double", (_socket, { value }: { value: number }) => value * 2],
      ]),
    });
    assert.equal(await c.call("callback", { value: 21 }), 42);
  } finally {
    await app.close();
  }
});
