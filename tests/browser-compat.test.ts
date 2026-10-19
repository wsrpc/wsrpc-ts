import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const { exercise, loadClient } = await import(
  new URL("../../tests/fixtures/browser-compat.mjs", import.meta.url).href
);
const file = (path: string) =>
  fileURLToPath(new URL(`../../${path}`, import.meta.url));
test("published compatibility fixtures retain their original bytes", () => {
  const hashes = JSON.parse(
    readFileSync(file("tests/fixtures/client-4.4.1-sha256.json"), "utf8"),
  );
  for (const [name, hash] of Object.entries(hashes)) {
    assert.equal(
      createHash("sha256")
        .update(readFileSync(file(`tests/fixtures/${name}`)))
        .digest("hex"),
      hash,
    );
  }
});
for (const [old, current] of [
  ["tests/fixtures/client-4.4.1.mjs", "packages/client/wsrpc.es6.js"],
  ["tests/fixtures/client-4.4.1.min.js", "packages/client/dist/wsrpc.min.js"],
]) {
  for (const explicitTimeout of [false, true]) {
    test(`legacy API and exact frames match published 4.4.1 (${current}, ${explicitTimeout ? "two" : "one"} constructor args)`, async () => {
      const previous = await exercise(file(old!), undefined, explicitTimeout);
      const next = await exercise(file(current!), undefined, explicitTimeout);
      assert.deepEqual(
        JSON.parse(JSON.stringify(next)),
        JSON.parse(JSON.stringify(previous)),
      );
    });
  }
}
for (const current of [
  "packages/client/wsrpc.es6.js",
  "packages/client/dist/wsrpc.min.js",
]) {
  test(`raw frame observer covers all send/receive paths and isolates failures (${current})`, async () => {
    const observed: { direction: string; data: unknown }[] = [];
    let counter = 0;
    const actual = await exercise(file(current), {
      onFrame(frame: { direction: string; data: unknown }) {
        assert.ok(Object.isFrozen(frame));
        observed.push({ direction: frame.direction, data: frame.data });
        if (++counter % 2) throw new Error("Observer failed synchronously");
        return Promise.reject(new Error("Observer failed asynchronously"));
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      observed
        .filter((frame) => frame.direction === "out")
        .map((frame) =>
          typeof frame.data === "string"
            ? frame.data
            : [...(frame.data as Uint8Array)],
        ),
      actual.wire,
    );
    assert.deepEqual(
      observed
        .filter((frame) => frame.direction === "in")
        .map((frame) => frame.data),
      actual.incoming,
    );
    const h = loadClient(file(current));
    const frames: unknown[] = [];
    const rpc = new h.Client("ws://example.test/ws/", 1000, {
      onFrame: (frame: unknown) => frames.push(frame),
    });
    rpc.connect();
    h.sockets[0].open();
    h.sockets[0].receive("{ malformed");
    assert.equal((frames[0] as { data: string }).data, "{ malformed");
    assert.equal((frames[1] as { direction: string }).direction, "out");
  });
}
