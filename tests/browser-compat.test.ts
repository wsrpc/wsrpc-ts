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

  test(`frame observation cannot replace, defer or mutate transport payloads (${current})`, async () => {
    const baseline = await exercise(file(current));
    const pending = await exercise(file(current), {
      onFrame() {
        return new Promise(() => {}); // Rendering may never finish.
      },
    });
    assert.deepEqual(pending.wire, baseline.wire);
    const replaced = await exercise(file(current), {
      onFrame(frame: { data: unknown }) {
        assert.equal(Reflect.set(frame, "data", "replacement"), false);
        return "replacement"; // Observer results are not protocol input.
      },
    });
    assert.deepEqual(replaced.wire, baseline.wire);

    const h = loadClient(file(current));
    const snapshots: unknown[] = [];
    const rpc = new h.Client("ws://example.test/ws/", 1000, {
      onFrame(frame: { direction: string; data: unknown }) {
        // Even synchronous observers run only after send has succeeded.
        assert.equal(frame.direction, "out");
        assert.equal(h.wire.length, snapshots.length + 1);
        snapshots.push(frame.data);
        const bytes = ArrayBuffer.isView(frame.data)
          ? new Uint8Array(
              frame.data.buffer,
              frame.data.byteOffset,
              frame.data.byteLength,
            )
          : new Uint8Array(frame.data as ArrayBuffer);
        bytes.fill(99);
      },
    });
    rpc.connect();
    h.sockets[0].open();
    const buffer = new Uint8Array([0, 1, 255, 3]);
    rpc.sendRaw(buffer.subarray(1, 3));
    rpc.sendRaw(buffer.buffer);
    assert.deepEqual([...buffer], [0, 1, 255, 3]);
    assert.deepEqual([...h.wire[0]], [1, 255]);
    assert.equal(h.wire[1], buffer.buffer);
    assert.notEqual(snapshots[0], h.wire[0]);
    assert.notEqual(snapshots[1], buffer.buffer);
    assert.equal(snapshots.length, 2);
    assert.deepEqual(h.errors, []);
  });

  test(`broken observer setup and error reporting cannot break RPC (${current})`, async () => {
    const h = loadClient(file(current));
    h.context.console.error = () => {
      throw new Error("Broken error UI");
    };
    for (const options of [
      {
        onFrame() {
          throw new Error("Broken rendering");
        },
      },
      {
        onFrame() {
          return Promise.reject(new Error("Async rendering"));
        },
      },
      {
        get onFrame() {
          throw new Error("Broken observer getter");
        },
      },
    ]) {
      const rpc = new h.Client("ws://example.test/ws/", 1000, options);
      rpc.connect();
      const socket = h.sockets.at(-1);
      socket.open();
      const result = rpc.call("echo", { value: 42 });
      socket.receive(
        JSON.stringify({ id: JSON.parse(socket.sent.at(-1)).id, result: 42 }),
      );
      assert.equal(await result, 42);
    }
    await new Promise((resolve) => setImmediate(resolve));
  });
}
