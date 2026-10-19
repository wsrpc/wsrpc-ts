import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketAsync } from "@wsrpc/server";
import { fixture } from "./helpers.js";
class RPC extends WebSocketAsync {}
RPC.addRoute("echo", (_socket, params: unknown) => params);
RPC.addRoute("reverse", (socket, params: { value: number }) =>
  socket.call("double", params),
);
for (const mode of ["esm", "commonjs", "script", "subpath"]) {
  test(`the client package ${mode} entry supports bidirectional RPC`, async () => {
    const f = await fixture(RPC);
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              "../../tests/fixtures/package-client-runner.mjs",
              import.meta.url,
            ),
          ),
          f.url,
          mode,
        ],
        { timeout: 5000 },
      );
      assert.match(stdout, /passed/);
    } finally {
      await f.close();
    }
  });
}
