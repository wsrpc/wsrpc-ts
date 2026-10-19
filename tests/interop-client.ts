import assert from "node:assert/strict";
import { RemoteError, WSRPCClient } from "../src/index.js";
const client = await WSRPCClient.connect(process.argv[2]!, {
  routes: new Map([
    ["double", (_socket, { value }: { value: number }) => value * 2],
  ]),
});
try {
  assert.deepEqual(await client.call("echo", { text: "Привет 🐍", value: 0 }), {
    text: "Привет 🐍",
    value: 0,
  });
  assert.equal(await client.call("reverse", { value: 21 }), 42);
  assert.deepEqual(await client.call("ping", { ok: false }), { ok: false });
  await assert.rejects(
    client.call("fail"),
    (error) =>
      error instanceof RemoteError &&
      (error.payload as { type: string }).type === "ValueError",
  );
  console.log("TypeScript client interoperability passed");
} finally {
  await client.close();
}
