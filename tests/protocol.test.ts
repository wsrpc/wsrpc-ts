import { WSRPCClient } from "@wsrpc/client/node";
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  AllowedRoute,
  CapacityError,
  CallTimeoutError,
  ConnectionClosedError,
  PrefixRoute,
  RemoteError,
  Route,
  RPCPeer,
  WebSocketAsync,
  noproxy,
} from "@wsrpc/server";
import { delay, fixture } from "./helpers.js";

class Counter extends AllowedRoute {
  value = 0;
  init({ value }: { value: number }) {
    this.value = value;
    return this.value;
  }
  add({ value }: { value: number }) {
    this.value += value;
    return this.value;
  }
  _secret() {
    return "secret";
  }
  hidden() {
    return "hidden";
  }
}
noproxy(Counter.prototype.hidden);
class Prefixed extends PrefixRoute {
  rpc_echo(params: unknown) {
    return params;
  }
}
class Explicit extends Route {
  static override methods = new Set(["allowed"]);
  allowed() {
    return true;
  }
  secret() {
    return "hidden";
  }
}
class RPC extends WebSocketAsync {}
RPC.addRoute("echo", (_socket, params: unknown) => params);
RPC.addRoute("counter", Counter);
RPC.addRoute("prefixed", Prefixed);
RPC.addRoute("explicit", Explicit);
RPC.addRoute("reverse", (socket, params: { value: number }) =>
  socket.call("double", params),
);
RPC.addRoute("fail", () => {
  throw new TypeError("Expected failure");
});
RPC.addRoute("wait", async (_socket, { ms }: { ms: number }) => {
  await delay(ms);
  return ms;
});

for (const value of [
  0,
  false,
  "",
  null,
  { text: "Привет 🐍", nested: [0, false] },
  [1, 2],
]) {
  test(`JSON result preserves ${JSON.stringify(value)}`, async () => {
    const f = await fixture(RPC);
    try {
      const c = await f.connect();
      assert.deepEqual(await c.call("echo", value), value ?? {});
      assert.equal(
        await c
          .call("ping", { pong: true })
          .then((x) => (x as { pong: boolean }).pong),
        true,
      );
    } finally {
      await f.close();
    }
  });
}
test("route instances are per connection, init explicit, policy blocks private/prototype methods", async () => {
  const f = await fixture(RPC);
  try {
    const a = await f.connect();
    const b = await f.connect();
    assert.equal(await a.call("counter", { value: 10 }), 10);
    assert.equal(await a.call("counter.add", { value: 2 }), 12);
    assert.equal(await b.call("counter.add", { value: 1 }), 1);
    assert.deepEqual(await a.call("prefixed.echo", { value: 3 }), { value: 3 });
    assert.equal(await a.call("explicit.allowed"), true);
    for (const method of [
      "counter.hidden",
      "counter.toString",
      "explicit.secret",
    ]) {
      await assert.rejects(a.call(method), RemoteError);
    }
    for (const method of [
      "counter._secret",
      "counter.constructor",
      "__proto__",
    ]) {
      await assert.rejects(a.call(method), TypeError);
    }
  } finally {
    await f.close();
  }
});
test("callbacks, concurrent out-of-order calls, failure payloads and independent broadcast", async () => {
  const f = await fixture(RPC);
  try {
    const routes = new Map([
      ["double", (_socket: RPCPeer, { value }: { value: number }) => value * 2],
    ]);
    const a = await WSRPCClient.connect(f.url, { routes });
    const b = await WSRPCClient.connect(f.url, { routes });
    assert.equal(await a.call("reverse", { value: 21 }), 42);
    const remote = a.remote<{
      reverse: (params: { value: number }) => number;
    }>();
    assert.equal(await remote.reverse({ value: 3 }), 6);
    const order: number[] = [];
    await Promise.all(
      [40, 1, 10].map((ms) =>
        a.call<number>("wait", { ms }).then((result) => order.push(result)),
      ),
    );
    assert.deepEqual(order, [1, 10, 40]);
    await assert.rejects(
      a.call("fail"),
      (error) =>
        error instanceof RemoteError &&
        (error.payload as { type: string }).type === "TypeError",
    );
    const results = await f.rpc.broadcast("double", { value: 4 });
    assert.deepEqual(results, [
      { status: "fulfilled", value: 8 },
      { status: "fulfilled", value: 8 },
    ]);
    await b.close();
  } finally {
    await f.close();
  }
});
test("timeout and AbortSignal release pending calls and ignore late replies", async () => {
  const f = await fixture(RPC);
  try {
    const c = await f.connect();
    await assert.rejects(
      c.call("wait", { ms: 40 }, { timeout: 2 }),
      CallTimeoutError,
    );
    assert.equal(c.pendingCalls, 0);
    const controller = new AbortController();
    const pending = c.call("wait", { ms: 40 }, { signal: controller.signal });
    controller.abort(new Error("Stop"));
    await assert.rejects(pending, /Stop/);
    assert.equal(c.pendingCalls, 0);
    await delay(60);
    assert.equal(await c.call("echo", 42), 42);
  } finally {
    await f.close();
  }
});
test("disconnect aborts handlers, rejects outgoing calls and invokes close hooks once", async () => {
  let closed = 0;
  let aborted = false;
  class Resource extends AllowedRoute {
    override _onClose() {
      closed++;
    }
    init() {
      return true;
    }
  }
  class Server extends WebSocketAsync {}
  Server.addRoute("resource", Resource);
  Server.addRoute(
    "hold",
    (socket) =>
      new Promise((resolve) =>
        socket.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve(null);
          },
          { once: true },
        ),
      ),
  );
  const f = await fixture(Server);
  const c = await f.connect();
  await c.call("resource");
  const pending = c.call("hold");
  const rejected = assert.rejects(pending, ConnectionClosedError);
  await delay(5);
  await f.close();
  await rejected;
  assert.equal(closed, 1);
  assert.equal(aborted, true);
  assert.equal(c.pendingCalls, 0);
  await c.close();
});
test("limits, serialization failure and failing signal handlers do not leak pending calls", async () => {
  const f = await fixture(RPC, { maxConcurrentCalls: 1 });
  try {
    const c = await WSRPCClient.connect(f.url, { maxPendingCalls: 1 });
    const first = c.call("wait", { ms: 30 });
    await assert.rejects(c.call("echo"), CapacityError);
    await first;
    await assert.rejects(c.call("echo", 1n), TypeError);
    assert.equal(c.pendingCalls, 0);
    const peer = [...f.rpc.clients.values()][0]!;
    peer.onCallStart.connect(() => {
      throw new Error("observer failed");
    });
    assert.equal(await c.call("echo", 42), 42);
    const other = await f.connect();
    const [slow, busy] = await Promise.allSettled([
      other.call("wait", { ms: 40 }),
      other.call("echo"),
    ]);
    assert.equal(slow!.status, "fulfilled");
    assert.ok(
      busy!.status === "rejected" &&
        busy.reason instanceof RemoteError &&
        (busy.reason.payload as { type: string }).type === "CapacityError",
    );
  } finally {
    await f.close();
  }
});
test("binary and application events are distinct from RPC replies", async () => {
  const f = await fixture(RPC);
  try {
    const c = await f.connect();
    const peer = [...f.rpc.clients.values()][0]!;
    const event = new Promise((resolve) =>
      c.onEvent.connect(resolve as (value: Record<string, unknown>) => void),
    );
    await peer.emit({ topic: "ready", value: 0 });
    assert.deepEqual(await event, { topic: "ready", value: 0 });
    const binary = new Promise<Uint8Array>((resolve) =>
      peer.onBinary.connect((value) => {
        resolve(value);
      }),
    );
    await c.sendRaw(new Uint8Array([0, 255, 128]));
    assert.deepEqual([...(await binary)], [0, 255, 128]);
    await assert.rejects(c.emit({ id: 1 }), TypeError);
  } finally {
    await f.close();
  }
});
test("malformed frames and duplicate in-flight IDs close without running duplicate methods", async () => {
  const f = await fixture(RPC);
  try {
    for (const data of ["invalid JSON", "[]", '{"id":"bad","method":"echo"}']) {
      const raw = new WebSocket(f.url);
      await once(raw, "open");
      const closed = once(raw, "close");
      raw.send(data);
      const [code] = await closed;
      assert.ok(code === 1007 || code === 1008);
    }
    const raw = new WebSocket(f.url);
    await once(raw, "open");
    const closed = once(raw, "close");
    raw.send(JSON.stringify({ id: 7, method: "wait", params: { ms: 30 } }));
    raw.send(JSON.stringify({ id: 7, method: "wait", params: { ms: 30 } }));
    assert.equal((await closed)[0], 1008);
  } finally {
    await f.close();
  }
});
test("subclass routes and endpoint snapshots remain isolated", async () => {
  class A extends WebSocketAsync {}
  class B extends WebSocketAsync {}
  A.addRoute("onlyA", () => true);
  const f = await fixture(A);
  const b = await fixture(B);
  A.addRoute("later", () => true);
  try {
    const aClient = await f.connect();
    const bClient = await b.connect();
    assert.equal(await aClient.call("onlyA"), true);
    await assert.rejects(aClient.call("later"), RemoteError);
    await assert.rejects(bClient.call("onlyA"), RemoteError);
  } finally {
    await f.close();
    await b.close();
  }
});
test("HTTP upgrades can be authorized before acceptance with context and bounded timeout", async () => {
  class Context extends WebSocketAsync {}
  Context.addRoute("who", (socket) => socket.context);
  const f = await fixture(Context, {
    authorize: (request) =>
      request.headers.authorization === "Bearer test"
        ? { user: "test" }
        : false,
  });
  try {
    await assert.rejects(WSRPCClient.connect(f.url), /403/);
    const c = await WSRPCClient.connect(f.url, {
      websocket: { headers: { authorization: "Bearer test" } },
    });
    assert.deepEqual(await c.call("who"), { user: "test" });
    const http = await fetch(
      f.url.replace("ws:", "http:").replace("/ws/", "/health"),
    );
    assert.equal(await http.text(), "HTTP works");
  } finally {
    await f.close();
  }
  const slow = await fixture(Context, {
    authorizationTimeout: 5,
    authorize: () => new Promise(() => {}),
  });
  try {
    await assert.rejects(WSRPCClient.connect(slow.url));
  } finally {
    await slow.close();
  }
});
test("custom codecs are honored on both sides", async () => {
  const codec = {
    loads: (text: string) => JSON.parse(text),
    dumps: (value: unknown) => JSON.stringify(value) + " ",
  };
  const f = await fixture(RPC, { codec });
  try {
    const c = await WSRPCClient.connect(f.url, { codec });
    assert.equal(await c.call("echo", false), false);
  } finally {
    await f.close();
  }
});
test("existing unmodified JavaScript client can call and receive callbacks", async () => {
  const f = await fixture(RPC);
  try {
    await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../tests/fixtures/legacy-runner.mjs", import.meta.url),
        ),
        f.url,
      ],
      { timeout: 10_000 },
    );
  } finally {
    await f.close();
  }
});

test("null/undefined results and send-buffer failures preserve protocol state", async () => {
  class Values extends WebSocketAsync {}
  Values.addRoute("value", (_socket, { value }: { value: unknown }) => value);
  Values.addRoute("nothing", () => undefined);
  const f = await fixture(Values);
  try {
    const c = await f.connect();
    assert.equal(await c.call("value", { value: null }), null);
    assert.equal(await c.call("nothing"), null);
    const bounded = await WSRPCClient.connect(f.url, { maxBufferedBytes: 10 });
    await assert.rejects(
      bounded.call("value", { value: "large" }),
      CapacityError,
    );
    assert.equal(bounded.pendingCalls, 0);
  } finally {
    await f.close();
  }
});

test("oversized payloads close the transport and release the client", async () => {
  const f = await fixture(RPC, { maxPayload: 64 });
  try {
    const c = await f.connect();
    await assert.rejects(
      c.call("echo", { message: "x".repeat(256) }),
      ConnectionClosedError,
    );
    assert.equal(c.pendingCalls, 0);
  } finally {
    await f.close();
  }
});

test("shutdown cancels authorization before an upgrade completes", async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted = false;
  const f = await fixture(RPC, {
    authorize: (_request, signal) => {
      started();
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => {});
    },
  });
  const rejected = assert.rejects(WSRPCClient.connect(f.url));
  await entered;
  await f.close();
  await rejected;
  assert.equal(aborted, true);
});

test("other WebSocket upgrade routes can coexist on the same HTTP server", async () => {
  const f = await fixture(RPC);
  const { WebSocketServer } = await import("ws");
  const other = new WebSocketServer({ noServer: true });
  f.server.on("upgrade", (request, socket, head) => {
    if (request.url === "/other")
      other.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", (data) => ws.send(data));
      });
  });
  try {
    const c = await f.connect();
    assert.equal(await c.call("echo", 42), 42);
    const raw = new WebSocket(f.url.replace("/ws/", "/other"));
    await once(raw, "open");
    const message = once(raw, "message");
    raw.send("plain ws");
    assert.equal((await message)[0].toString(), "plain ws");
    const closed = once(raw, "close");
    raw.close();
    await closed;
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()));
    await f.close();
  }
});
