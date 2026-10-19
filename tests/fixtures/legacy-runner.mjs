// The original client reconnects even after destroy(). Isolate its lifetime.
import assert from "node:assert/strict";
import Legacy from "./legacy-client.js";
const client = new Legacy(process.argv[2]);
client.addRoute("double", ({ value }) => value * 2);
const connected = client.onEvent("onconnect");
client.connect();
try {
  await connected;
  assert.deepEqual(await client.call("echo", { message: "Hello" }), {
    message: "Hello",
  });
  assert.equal(await client.call("reverse", { value: 21 }), 42);
  client.destroy();
  process.exit(0);
} catch (error) {
  console.error(error);
  client.destroy();
  process.exit(1);
}
