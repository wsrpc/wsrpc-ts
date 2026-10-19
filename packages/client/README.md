# @wsrpc/client

The existing WSRPC browser client, now maintained alongside `@wsrpc/server`
in [wsrpc-ts](https://github.com/wsrpc/wsrpc-ts). Its original Git history,
MIT license and browser API are preserved. Version 4.5 adds TypeScript
declarations and the Node.js client without changing browser call signatures.

```javascript
import WSRPC from "@wsrpc/client";
const rpc = new WSRPC("ws://127.0.0.1:8000/ws/");
rpc.addRoute("double", ({ value }) => value * 2);
const connected = rpc.onEvent("onconnect");
rpc.connect();
await connected;
console.log(await rpc.proxy.echo({ message: "Hello" }));
```

CommonJS `require("@wsrpc/client")` still returns the browser constructor.
The files `wsrpc.es6.js`, `dist/wsrpc.js`, `dist/wsrpc.min.js` and their source
maps remain available. Serve `dist/wsrpc.min.js` as a classic script to get
`window.WSRPC`. The browser client retains its reconnect behavior.

The browser/core package has no runtime dependencies. For Node.js 22+, install
the optional transport with `npm install @wsrpc/client ws`. TypeScript Node
applications also install `npm install --save-dev @types/ws @types/node`.
Then use the separately imported, typed `ws` transport:

```javascript
import { WSRPCClient } from "@wsrpc/client/node";
const rpc = await WSRPCClient.connect("ws://127.0.0.1:8000/ws/");
try {
  console.log(await rpc.call("echo", { message: "Hello" }));
} finally {
  await rpc.close();
}
```

The transport-independent protocol and route classes are exported through
`@wsrpc/client/core`. Node transports use async-local context for shared
Route instances and `getCurrentSocket()`. See the
[documentation](https://docs.wsrpc.org/typescript/) for routes and callbacks.

Contact: orlovdl@gmail.com.

## Observe raw browser frames

The third constructor argument is optional. Existing `new WSRPC(url)` and
`new WSRPC(url, reconnectTimeout)` calls keep their behavior:

```javascript
const rpc = new WSRPC("ws://127.0.0.1:8000/ws/", 1000, {
  onFrame({ direction, data }) {
    console.log(direction, data); // "in" or "out", unchanged application payload
  },
});
rpc.connect();
```

Incoming payloads are observed before JSON parsing, including malformed JSON.
Outgoing payloads are observed once after `WebSocket.send` accepts them;
queued calls appear when flushed, rather than when queued. This covers RPC
calls, callback results/errors, protocol errors and `sendRaw` payloads.
WebSocket control frames are managed by the browser and are not exposed.
The metadata object is frozen. Binary payloads are passed by reference for
inspection. Synchronous exceptions and rejected Promises from `onFrame` are
reported to `console.error` and do not affect RPC dispatch.
`WSRPC.DEBUG` and `WSRPC.TRACE` retain their original boolean behavior.

## Workers and other WebSocket runtimes

Use `@wsrpc/client/core` for a transport-independent peer in Workers, Deno or
Bun. It has no Node imports or runtime dependencies. The root import under
`workerd` or `worker` conditions resolves directly to this core; ordinary browser
and Node imports keep the existing browser default export.

The host supplies a Transport and feeds frames into `peer.receive()`. Here is
a complete Cloudflare Worker, also checked in `examples/workers/worker.ts`:

```typescript
import { RPCPeer } from "@wsrpc/client/core";

export default {
  fetch(request: Request): Response {
    if (new URL(request.url).pathname !== "/ws/")
      return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0],
      server = pair[1];
    server.binaryType = "arraybuffer";
    server.accept();
    const peer = new RPCPeer({
      send(data) {
        server.send(data);
      },
      close(code, reason) {
        server.close(code, reason);
      },
    });
    peer.addRoute("echo", (_socket, params: unknown) => params);
    peer.addRoute("callback", (socket, params: { value: number }) =>
      socket.call("double", params),
    );
    server.addEventListener("message", (event) => {
      const binary = typeof event.data !== "string";
      const data =
        typeof event.data === "string"
          ? event.data
          : new Uint8Array(event.data);
      void peer
        .receive(data, binary)
        .catch(() => peer.close(1011, "RPC dispatch failed"));
    });
    server.addEventListener("close", () => {
      void peer.close();
    });
    server.addEventListener("error", () => {
      void peer.close(1011, "WebSocket error");
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
```

No `nodejs_compat` flag is needed. Use connection-bound Route classes or the
explicit socket argument; implicit async-local context requires a host-provided
context storage implementation. The Node adapter installs it automatically.
Only the core is portable: `@wsrpc/client/node` and `@wsrpc/server` are Node
adapters. Deno/Bun applications can supply their native WebSocket transport;
the workerd integration is tested directly with Miniflare.

See [Cloudflare's WebSocket API](https://developers.cloudflare.com/workers/runtime-apis/websockets/).

`npm run test:workers` checks condition resolution, the complete module graph,
Worker declarations and a real bidirectional WebSocket call in workerd without
Node compatibility.

## Original project documentation

WSRPC client
------------

[![license](https://img.shields.io/npm/l/wsrpc-python.svg)](https://npmjs.com/package/wsrpc-python)

Easy to use javascript client for
[wsrpc-aiohttp](https://pypi.org/project/wsrpc-aiohttp/) or
[wsrpc-tornado](https://pypi.org/project/wsrpc-tornado/) websocket servers.

See [online demo](https://demo.wsrpc.info/) and
[documentation](https://docs.wsrpc.info/) with examples.

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [API](#api)
  - [Global configuration](#global-configuration)
  - [Constructor options](#constructor-options)
  - [Methods](#methods)

# Features

- Allows to call server functions from the client side and to
  call client functions from the server side (e.g. to notify clients about
  events);
- Async connection protocol: both server or client are able to call
  multiple functions and get responses as soon as each response would be
  ready in any order;
- Transfers any exceptions from a client side to the server side and
  vise versa;
- No dependencies;
- Messaging is based on [JsonRPC](https://www.jsonrpc.org) protocol;
- Provides typescript interface, ES6 module and
  [UMD](https://github.com/umdjs/umd) distribution as well.
- Ability to implement very complex scenarios.

# Installation

Install via npm:

    npm install @wsrpc/client

# Usage

Let's implement application, that tells jokes by request and collects feedback
about them (see [jsfiddle](https://jsfiddle.net/ke3z4bph/)).

[Backend](<(https://github.com/wsrpc/wsrpc-aiohttp/blob/master/docs/source/examples/server.py)>)
is located at [demo.wsrpc.info](https://docs.wsrpc.info/).

```html
<script type="text/javascript" src="//unpkg.com/@wsrpc/client"></script>
<script>
  var RPC = new WSRPC("wss://demo.wsrpc.info/ws/", 5000);

  // Register client route, that can be called by server.
  // It would be called by server, when server sends a joke.
  RPC.addRoute("joke", function (data) {
    // After server sends a joke server waits for an answer, if joke is
    // funny. test.getJoke call is going to be finished only after user
    // sends response.
    return confirm(data.joke + "\n\nThat was funny?");
  });
  RPC.connect();

  // Request server to tell a joke by calling test.getJoke
  // Server would call client route 'joke' (registered above) and wait for
  // client answer (if joke is funny or not).
  RPC.call("test.getJoke", {}).then(
    (result) => {
      // Here you would finally see server reaction on your feedback about
      // joke.
      // If 'joke' client route responds that joke is funny - you would see
      // something like 'Cool!', or 'Hmm... try again' if it's not.
      alert(result);
    },
    (error) => {
      alert(error.type + '("' + error.message + '")');
    },
  );
</script>
```

# API

## Global configuration

#### WSRPC.DEBUG

Static boolean flag, controls whether debug information should be displayed.

Can be enabled/disabled at any moment.

```js
WSRPC.DEBUG = true;
var RPC = new WSRPC(...);
...
```

#### WSRPC.TRACE

Static boolean flag, controls whether information about events and errors
should be traced.

Can be enabled/disabled at any moment.

```js
WSRPC.TRACE = true;
var RPC = new WSRPC(...);
...
```

## Constructor options

URL, reconnectTimeout = 1000

| Parameter          | Type   | Required | Description                                     |
| ------------------ | ------ | -------- | ----------------------------------------------- |
| `URL`              | string | Yes      | Absolute or relative URL                        |
| `reconnectTimeout` | number | No       | Timeout for reconnecting, defaults to `1000` ms |

```js
// Url can be relative (schema for websocket would be detected automatically
// depending on page http/https schema)
var RelativeUrlRPC = new WSRPC("/ws/", 5000);

// Absolute websocket url example
var UnsecureRPC = new WSRPC("ws://example.com/ws", 5000);

// Secure absolute websocket url example
var SecureRPC = new WSRPC("wss://example.com/ws", 5000);
```

## Methods

#### WSRPC.connect()

Establishes connection with the server.

```js
var RPC = new WSRPC(url);
RPC.connect();
```

#### WSRPC.destroy()

Closes socket.

```js
var RPC = new WSRPC(url);

var deferred = RPC.onEvent("onconnect");
deferred.resolve = function () {
  RPC.destroy();
};

RPC.connect();
```

#### WSRPC.state()

Get current socket state as a string.

Possible values: `CONNECTING`, `OPEN`, `CLOSING`, `CLOSED`.

```js
var RPC = new WSRPC(url);
console.log(RPC.state()); // Displays CLOSED
```

#### WSRPC.stateCode()

Get current socket state code (integer). Possible values:

| Code | State      |
| ---- | ---------- |
| 0    | CONNECTING |
| 1    | OPEN       |
| 2    | CLOSING    |
| 3    | CLOSED     |

```js
var RPC = new WSRPC(url);
console.log(RPC.stateCode()); // Displays 3
```

#### WSRPC.addRoute(name, callback)

Register route on the client with specified name, route added later replaces
route added earlier with the same name.

| Parameter | Type     |
| --------- | -------- |
| name      | string   |
| callback  | function |

Callback would be called with `object` type parameter `data` containing
parameters from server. Callback return value would be received by server.

```js
var RPC = new WSRPC(url);
RPC.addRoute("askUser", function (data) {
  // Data is object, containing parameters from server.
  // Would display question ask user to enter response and return response
  // to the server.
  return { response: prompt(data.question) };
});
```

#### WSRPC.deleteRoute(name)

Remove specified client route.

| Parameter | Type   |
| --------- | ------ |
| name      | string |

```js
var RPC = new WSRPC(url);
RPC.addRoute("askUser", function () {
  return {};
});
RPC.deleteRoute("askUser");
```

#### WSRPC.call(route, params)

Call server function with specified parameters, returns `Promise` that can be
awaited using await syntax.

| Parameter | Type   |
| --------- | ------ |
| route     | string |
| params    | object |

```js
var RPC = new WSRPC(url);
RPC.connect();
RPC.call("serverRoute", {
  param1: "value1",
  param2: "value2",
}).then(
  (result) => {
    alert(result);
  },
  (error) => {
    alert(error.type + '("' + error.message + '")');
  },
);
```

#### WSRPC.addEventListener(event, callback)

Add permanent callback for event (see `onEvent` to register one time event).
Returns eventId, that can be used later to remove event.

| Parameter | Type     |
| --------- | -------- |
| event     | string   |
| callback  | function |

```js
var RPC = new WSRPC(url);
RPC.addEventListener("onconnect", function () {
  console.log("Connected to the server!");
});
```

#### WSRPC.removeEventListener(event, eventId)

Remove event listener using eventId (returned by `addEventListener`).

| Parameter | Type    |
| --------- | ------- |
| event     | string  |
| eventId   | integer |

```js
var RPC = new WSRPC(url);
var eventId = RPC.addEventListener("onconnect", function () {
  console.log("Connected to the server!");
});
RPC.removeEventListener("onconnect", eventId);
```

#### WSRPC.onEvent(event)

Get deferred object, that would execute only once for specified event.
deferred.promise is a native `Promise` and can be awaited using await syntax.

| Parameter | Type   |
| --------- | ------ |
| event     | string |

```js
var RPC = new WSRPC(url);

var deferred = RPC.onEvent("onconnect");
deferred.resolve = function () {
  RPC.destroy();
};

RPC.connect();
```

#### WSRPC.proxy

Proxy for `WSRPC.call` method to call the remote functions by dot notation.

| Parameter | Type   |
| --------- | ------ |
| params    | object |

```js
var RPC = new WSRPC(url);
RPC.connect();
RPC.proxy
  .serverRoute({
    param1: "value1",
    param2: "value2",
  })
  .then(
    (result) => {
      alert(result);
    },
    (error) => {
      alert(error.type + '("' + error.message + '")');
    },
  );
```

### Proxy Routes

#### Function based Proxy example:

Python server code:

```python
from wsrpc_aiohttp import WebSocketAsync

async def subtract(socket: WebSocketAsync, *, a, b):
    return a - b

WebSocketAsync.add_route('subtract', subtract)
```

Javascript client code:

```js
var RPC = new WSRPC(url);
RPC.connect();
await RPC.proxy.subtract({ a: 1, b: 9 });
```

#### Class based Proxy example:

Python server code:

```python
from wsrpc_aiohttp import decorators, WebSocketAsync

class Storage(Route):
    async def init(self):
        self._internal = dict()

    @decorators.proxy
    async def get(self, key, default=None):
        return self._internal.get(key, default)

    @decorators.proxy
    async def set(self, key, value):
        self._internal[key] = value
        return True

WebSocketAsync.add_route('kv', Storage)
```

Javascript client code:

```js
var RPC = new WSRPC(url);
RPC.connect();
await RPC.proxy.kv.set({ key: "foo", value: "bar" });
await RPC.proxy.kv.get({ key: "foo" });
```

# Versioning

This software follows [Semantic Versioning](http://semver.org/)
