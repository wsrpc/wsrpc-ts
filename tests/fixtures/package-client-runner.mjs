import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const mode = process.argv[3];
let WSRPC;
if (mode === "commonjs")
  WSRPC = createRequire(import.meta.url)("@wsrpc/client");
else if (mode === "script" || mode === "published-4.4.1") {
  const context = vm.createContext({
    WebSocket,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(
    readFileSync(
      new URL(
        mode === "published-4.4.1"
          ? "./client-4.4.1.min.js"
          : "../../packages/client/dist/wsrpc.min.js",
        import.meta.url,
      ),
      "utf8",
    ),
    context,
  );
  WSRPC = context.WSRPC;
} else
  WSRPC = (
    await import(
      mode === "subpath" ? "@wsrpc/client/wsrpc.es6.js" : "@wsrpc/client"
    )
  ).default;
const rpc = new WSRPC(process.argv[2]);
rpc.addRoute("double", ({ value }) => value * 2);
const connected = rpc.onEvent("onconnect");
rpc.connect();
try {
  await connected;
  // VM-returned objects have a different realm's prototype; compare their serialized value.
  assert.equal(
    JSON.stringify(await rpc.call("echo", { value: 0 })),
    '{"value":0}',
  );
  assert.equal(await rpc.proxy.reverse({ value: 21 }), 42);
  console.log(`Browser package ${mode} passed`);
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
