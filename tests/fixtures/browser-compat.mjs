import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

export function loadClient(path) {
  let source = readFileSync(path, "utf8");
  if (source.includes("export default WSRPC;"))
    source = source.replace(
      "export default WSRPC;",
      "globalThis.WSRPC = WSRPC;",
    );
  const sockets = [],
    timers = [],
    wire = [],
    incoming = [],
    errors = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    constructor(url) {
      this.url = url;
      this.sent = [];
      sockets.push(this);
    }
    send(data) {
      assert.equal(this.readyState, 1);
      this.sent.push(data);
      wire.push(data);
    }
    open() {
      this.readyState = 1;
      this.onopen({ type: "open" });
    }
    receive(data) {
      incoming.push(data);
      this.onmessage({ type: "message", data });
    }
    close() {
      this.readyState = 3;
      this.onclose({ type: "close" });
    }
  }
  const context = vm.createContext({
    WebSocket: Socket,
    setTimeout: (fn, delay) => timers.push({ fn, delay }),
    console: {
      error: (error) => errors.push(String(error)),
      log() {},
      info() {},
      group() {},
      groupEnd() {},
      trace() {},
    },
    window: {
      location: { protocol: "https:", host: "example.test", port: "" },
    },
  });
  vm.runInContext(source, context);
  return { Client: context.WSRPC, sockets, timers, wire, incoming, errors };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const last = (socket) => JSON.parse(socket.sent.at(-1));

export async function exercise(path, options, explicitTimeout = true) {
  const h = loadClient(path);
  const { Client, sockets, timers } = h;
  const rpc = options
    ? new Client("/ws/", 250, options)
    : explicitTimeout
      ? new Client("/ws/", 250)
      : new Client("/ws/");
  const states = [rpc.state(), rpc.stateCode(), Object.isFrozen(rpc)];
  const keys = Object.keys(rpc).sort();
  const transitions = [];
  const event = rpc.addEventListener("onchange", () =>
    transitions.push(rpc.state()),
  );
  const once = rpc.onEvent("onconnect");
  const queued = rpc.call("echo", { value: 0 });
  rpc.connect();
  states.push(rpc.state(), rpc.stateCode());
  const ws = sockets[0];
  assert.equal(ws.url, "wss://example.test:/ws/");
  ws.open();
  assert.equal(await once, undefined);
  ws.receive(JSON.stringify({ id: last(ws).id, result: 0 }));
  assert.equal(await queued, 0);
  const nested = rpc.proxy.counter.add({ value: 2 });
  assert.equal(last(ws).method, "counter.add");
  ws.receive(JSON.stringify({ id: last(ws).id, result: 2 }));
  assert.equal(await nested, 2);
  rpc.addRoute("double", ({ value }) => value * 2);
  ws.receive('{"id":2,"method":"double","params":{"value":21}}');
  await tick();
  assert.equal(last(ws).result, 42);
  rpc.addRoute(
    "deferred",
    function ({ value }) {
      this.resolve(value);
    },
    true,
  );
  ws.receive('{"id":4,"method":"deferred","params":{"value":false}}');
  await tick();
  assert.equal(last(ws).result, null); // Preserve the legacy falsy callback semantics.
  rpc.addRoute(
    "reject",
    function () {
      this.reject("denied");
    },
    true,
  );
  ws.receive('{"id":6,"method":"reject","params":{}}');
  await tick();
  assert.equal(last(ws).error, "denied");
  assert.equal(rpc.deleteRoute("double"), true);
  assert.equal(rpc.deleteRoute("double"), true); // JavaScript delete is true even for absent keys.
  const events = [];
  const listener = rpc.addServerEventListener(function (data) {
    events.push({ data, same: this === rpc });
  });
  ws.receive('{"topic":"updated","value":0}');
  assert.equal(rpc.removeServerEventListener(listener), 1);
  assert.equal(rpc.removeServerEventListener(listener), 0);
  const raw = new Uint8Array([0, 1, 255]);
  rpc.sendRaw(raw);
  assert.equal(ws.sent.at(-1), raw);
  // Unknown result must not produce a new outgoing RPC frame.
  const count = ws.sent.length;
  ws.receive('{"id":999,"result":"late"}');
  assert.equal(ws.sent.length, count);
  const failed = rpc.call("failure", {});
  ws.receive(
    JSON.stringify({
      id: last(ws).id,
      error: { type: "Error", message: "remote" },
    }),
  );
  await assert.rejects(failed, (error) => error.message === "remote");
  const pending = rpc.call("pending", {});
  const rejected = assert.rejects(
    pending,
    (error) => typeof error === "string",
  );
  ws.close();
  await rejected;
  assert.equal(timers[0].delay, explicitTimeout || options ? 250 : 1000);
  timers.shift().fn();
  assert.equal(sockets.length, 2);
  const second = sockets[1];
  const again = rpc.call("echo", { again: true });
  second.open();
  assert.equal(last(second).id, 3);
  second.receive('{"id":3,"result":{"again":true}}');
  assert.equal((await again).again, true);
  assert.equal(rpc.removeEventListener("onchange", event), true);
  assert.equal(rpc.removeEventListener("onchange", event), false);
  assert.equal(rpc.destroy(), undefined);
  assert.equal(timers.length, 1); // Legacy destroy still schedules reconnect.
  const closed = new Client("ws://example.test/ws/");
  await assert.rejects(
    closed.call("echo", {}, { noWait: true }),
    (error) => error === "Socket is: CLOSED",
  );
  return {
    keys,
    states,
    transitions,
    events,
    wire: h.wire.map((data) => (typeof data === "string" ? data : [...data])),
    incoming: h.incoming,
    errors: h.errors,
    delay: timers[0].delay,
  };
}
