import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AllowedRoute,
  WebSocketAsync,
  getCurrentCall,
  getCurrentSocket,
  noproxy,
  proxy,
  Route,
} from "@wsrpc/server";
import { WSRPCClient } from "@wsrpc/client/node";
import { delay, fixture } from "./helpers.js";

class Shared extends AllowedRoute {
  calls = 0;
  readonly closedSockets = new Set<string>();
  constructor(readonly dependency: { prefix: string }) {
    super();
  }
  async invoke({ value }: { value: number }) {
    const peer = this.socket;
    const call = getCurrentCall();
    this.calls++;
    await delay(value % 4);
    assert.equal(this.socket, peer);
    assert.equal(getCurrentSocket(), peer);
    assert.equal(getCurrentCall(), call);
    return {
      result: await this.socket.call("double", { value }),
      prefix: this.dependency.prefix,
      method: call.method,
    };
  }
  secret() {
    return "hidden";
  }
  override _onClose() {
    this.closedSockets.add(this.socket.id);
  }
}
noproxy(Shared.prototype.secret);

test("pre-created route objects retain dependencies and async context across connections", async () => {
  const shared = new Shared({ prefix: "injected" });
  class RPC extends WebSocketAsync {}
  RPC.addRoute("shared", shared);
  RPC.addRoute("alias", shared);
  RPC.addRoute("implicit", async function (_socket, params: { value: number }) {
    assert.equal(this, getCurrentSocket());
    await delay(2);
    assert.equal(this, getCurrentSocket());
    return this.call("double", params);
  });
  const f = await fixture(RPC);
  const connect = (multiplier: number) =>
    WSRPCClient.connect(f.url, {
      routes: new Map([
        ["double", (_peer, { value }: { value: number }) => value * multiplier],
      ]),
    });
  try {
    assert.throws(getCurrentSocket, /No active RPC/);
    assert.throws(getCurrentCall, /No active RPC/);
    const a = await connect(2),
      b = await connect(3);
    await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const client = i % 2 ? a : b;
        const actual = await client.call("shared.invoke", { value: i });
        assert.deepEqual(actual, {
          result: i * (i % 2 ? 2 : 3),
          prefix: "injected",
          method: "shared.invoke",
        });
      }),
    );
    assert.equal(shared.calls, 20);
    assert.equal(await a.call("implicit", { value: 5 }), 10);
    assert.equal(await b.call("implicit", { value: 5 }), 15);
    await assert.rejects(a.call("shared.secret"));
    await a.call("alias.invoke", { value: 1 });
    await a.close();
    await b.close();
    await f.rpc.close();
    assert.equal(shared.closedSockets.size, 2);
    assert.throws(() => shared.socket, /No active RPC/);
    assert.throws(getCurrentSocket, /No active RPC/);
  } finally {
    await f.close();
  }
});

test("changing a route registration replaces its cached object and closes every used object once", async () => {
  class Counter extends AllowedRoute {
    static closed = 0;
    read() {
      return "class";
    }
    override _onClose() {
      Counter.closed++;
    }
  }
  class RPC extends WebSocketAsync {}
  RPC.addRoute("counter", Counter);
  const f = await fixture(RPC);
  try {
    const c = await f.connect();
    assert.equal(await c.call("counter.read"), "class");
    const peer = [...f.rpc.clients.values()][0]!;
    peer.addRoute("counter", (_socket) => "function");
    assert.equal(await c.call("counter"), "function");
    peer.deleteRoute("counter");
    await assert.rejects(c.call("counter.read"));
    await f.rpc.close();
    assert.equal(Counter.closed, 1);
  } finally {
    await f.close();
  }
});

class Explicit extends Route {
  @proxy
  echo(params: unknown) {
    return params;
  }
  hidden() {
    return "hidden";
  }
}
test("proxy decorators expose explicit Route methods on classes and prepared objects", async () => {
  class RPC extends WebSocketAsync {}
  RPC.addRoute("class", Explicit);
  RPC.addRoute("instance", new Explicit());
  const f = await fixture(RPC);
  try {
    const c = await f.connect();
    for (const route of ["class", "instance"]) {
      assert.deepEqual(await c.call(`${route}.echo`, { value: 0 }), {
        value: 0,
      });
      await assert.rejects(c.call(`${route}.hidden`));
    }
  } finally {
    await f.close();
  }
});
