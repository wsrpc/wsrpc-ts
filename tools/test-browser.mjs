import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { WebSocketAsync } from "@wsrpc/server";

class RPC extends WebSocketAsync {}
RPC.addRoute("echo", (_socket, params) => params);
RPC.addRoute("callback", (socket, params) => socket.call("double", params));
RPC.addRoute("deferredCallback", (socket, params) =>
  socket.call("deferred", params),
);
RPC.addRoute("math.add", (_socket, { a, b }) => a + b);
RPC.addRoute("failure", () => {
  throw new Error("legacy failure");
});
const application = await readFile("tests/fixtures/legacy-application.html");
const original = await readFile("tests/fixtures/client-4.4.1.min.js");
const updated = await readFile("packages/client/dist/wsrpc.min.js");
let bundle = original;
const server = createServer((request, response) => {
  response.setHeader(
    "content-type",
    request.url === "/wsrpc.js" ? "application/javascript" : "text/html",
  );
  response.end(request.url === "/wsrpc.js" ? bundle : application);
});
const rpc = RPC.attach(server);
rpc.onConnect.connect((peer) => {
  peer.onBinary.connect((data) =>
    peer.emit({ topic: "binary", data: [...data] }),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch();
  const results = [];
  for (const [name, content] of [
    ["published 4.4.1", original],
    ["updated", updated],
  ]) {
    bundle = content;
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const result = await page.evaluate(() =>
        Promise.race([
          window.applicationDone,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Legacy application timed out")),
              5000,
            ),
          ),
        ]),
      );
      assert.deepEqual(errors, []);
      results.push(result);
      console.log(`Unchanged 4.4.1 application with ${name} bundle: passed`);
    } finally {
      await page.close();
    }
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[1], {
    echo: { text: "old application", value: 0 },
    callback: 42,
    deferred: 9,
    nested: 3,
    error: "legacy failure",
    bytes: [0, 1, 255],
    removed: 1,
    connections: 2,
    afterReconnect: { again: true },
    state: "OPEN",
    stateCode: 1,
  });
} finally {
  await browser?.close();
  await rpc.close();
  await new Promise((resolve) => server.close(resolve));
}
