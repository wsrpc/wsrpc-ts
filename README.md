# wsrpc-ts

Bidirectional WebSocket RPC for Node.js and TypeScript. It uses the WSRPC
protocol shared by `wsrpc-aiohttp`, `wsrpc-asgi` and the original browser
client. Both ends can expose methods and call each other over one connection.

The package is ESM, supports Node.js 22+, and uses `ws` for its Node transport.
The transport-independent implementation is also exported as
`@wsrpc/server/core`. The local package name is `@wsrpc/server`; it has not
been published to npm by this project.

## Run from this checkout

```sh
npm ci
npm run build
npm test
```

To run the complete examples, compile them and start a server:

```sh
npx tsc -p tsconfig.test.json
node build/examples/http.js
# Alternatives:
# node build/examples/express.js
# node build/examples/fastify.js
```

Each example is a standalone file with its RPC methods, framework integration,
HTTP `/health` endpoint and shutdown handling. In another terminal:

```sh
node build/examples/client.js
```

Expected output includes `{ message: 'Hello' }` and `42`, the latter produced
by a reverse call to the client's `double` route. After `npm run build`,
another application can install this checkout with `npm install /path/to/wsrpc-ts`.

## Server API

```typescript
import { createServer } from "node:http";
import { WebSocketAsync } from "@wsrpc/server";

class RPC extends WebSocketAsync {}

RPC.addRoute("echo", (_socket, params: Record<string, unknown>) => params);
RPC.addRoute("callback", (socket, { value }: { value: number }) =>
  socket.call<number>("double", { value }),
);

const http = createServer((_request, response) => response.end("Hello"));
const rpc = RPC.attach(http, { path: "/ws/" });
http.listen(8000, "127.0.0.1");

// During application shutdown:
// await rpc.close();
// http.close();
```

Use the same `attach(httpServer)` with Express's HTTP server or Fastify's
`app.server`. It does not replace HTTP request handling. Only the exact RPC
upgrade path is handled; other upgrade listeners can serve other WebSockets.
Call `rpc.close()` before closing the parent server. This detaches the upgrade
listener, aborts outstanding authorization and closes active RPC sockets.

A framework which already accepted a `ws` WebSocket can pass it to
`RPC.asServer().serve(webSocket)`. Create and retain that RPCServer once per
application so its clients, signals and shutdown remain available.

## Calls and typing

Callbacks receive `(socket, params)`. Object parameters are passed as one
object; arrays stay arrays. Unlike Python's keyword arguments, use object
destructuring for named parameters. A missing or null params field becomes
an empty object. An undefined result becomes JSON null.

```typescript
import { WSRPCClient } from "@wsrpc/server";

const client = await WSRPCClient.connect("ws://127.0.0.1:8000/ws/", {
  routes: new Map([
    ["double", (_socket, { value }: { value: number }) => value * 2],
  ]),
});
try {
  console.log(await client.call("callback", { value: 21 }));
} finally {
  await client.close();
}
```

`socket.proxy` provides dynamic dotted calls. For checked arguments and return
types, apply a remote contract with `remote<T>()`:

```typescript
interface Remote {
  counter: {
    add(params: { value: number }): number;
  };
}

// Inside a handler or after connecting:
// const remote = socket.remote<Remote>();
// const result: number = await remote.counter.add({ value: 2 });
```

These are compile-time contracts; validate incoming application data in handlers.
Calls run concurrently and can finish out of order. A handler can await a
reverse call without blocking the receipt of its reply. `call()` accepts a
third options argument: `{ timeout: 5000, signal: controller.signal }`.
Timeouts use milliseconds; zero disables the local timeout. Timeout/abort
removes the pending call locally; the existing wire protocol has no remote
cancellation message. Running handlers can observe `socket.signal` on disconnect.

## Routes with connection state

```typescript
import { AllowedRoute, WebSocketAsync } from "@wsrpc/server";

class Counter extends AllowedRoute {
  value = 0;
  init({ value = 0 }: { value?: number }) {
    this.value = value;
    return this.value;
  }
  add({ value }: { value: number }) {
    this.value += value;
    return this.value;
  }
  override _onClose() {
    // Release resources owned by this connection.
  }
}

class RPC extends WebSocketAsync {}
RPC.addRoute("counter", Counter);
```

Each connection lazily creates its own route instance. Calling `counter`
invokes `init` explicitly; `counter.add` invokes `add` without implicitly
calling `init`. `AllowedRoute`/`WebSocketRoute` expose public prototype methods.
Private names, constructors, getters, instance fields and Object methods are
excluded. Use `noproxy(Counter.prototype.someMethod)` to mask a public method.
`Route` requires an explicit static `methods` set; `PrefixRoute` exposes
`rpc_name` as `name` (its static `prefix` can be overridden).

A `WebSocketAsync` subclass owns its route registrations. Each RPCServer takes
an isolated snapshot when created. Register routes before `attach`/`asServer`;
`peer.addRoute()` and `deleteRoute()` change only that connection.

## Events, binary data and lifecycle

`await socket.emit({ topic: 'changed', value: 42 })` sends an event without
an RPC reply. Events cannot contain an `id`. `socket.onEvent.connect()`
registers an event listener. `sendRaw(Uint8Array)` and `onBinary` carry raw
binary WebSocket messages separately from JSON RPC.

`rpc.broadcast(method, params, options)` calls all current clients and returns
an array of `PromiseSettledResult` values. Clients and broadcasts are local
to the process; applications supply any cross-worker event distribution.

Signals use `connect(listener)` and return an unsubscribe function. The server
has `onConnect`, `onDisconnect` and `onError`; each peer has `onCallStart`,
`onCallSuccess`, `onCallFail`, `onEvent`, `onBinary`, `onClose` and `onError`.
Listener failures are reported through `onError`; they do not suppress replies
or prevent pending calls from being rejected on shutdown. `_onClose()` hooks
are awaited; keep them finite. Synchronous handlers execute on the Node event
loop. CPU-heavy work belongs in application-managed worker threads.

## Authorization, errors and limits

`RPC.attach(http, { authorize: (request, signal) => ... })` runs before the
WebSocket upgrade. Returning false produces HTTP 403; any other result becomes
`socket.context`. The signal aborts if the upgrade disconnects, authorization
times out or the server shuts down. Existing HTTP middleware does not perform
this upgrade authorization automatically.

| Option                 | Default | Unit / meaning                                      |
| ---------------------- | ------- | --------------------------------------------------- |
| `path`                 | `/ws/`  | Exact URL path, including the trailing slash        |
| `timeout`              | 30000   | Outgoing RPC timeout in milliseconds                |
| `maxPendingCalls`      | 1024    | Unanswered outgoing calls per connection            |
| `maxConcurrentCalls`   | 128     | Incoming handlers per connection                    |
| `maxPayload`           | 1048576 | Maximum incoming WebSocket message bytes            |
| `maxBufferedBytes`     | 1048576 | Maximum queued outgoing message bytes               |
| `authorizationTimeout` | 10000   | Milliseconds, zero disables the deadline            |
| `closeTimeout`         | 1000    | Milliseconds before terminating a closing ws socket |

Remote failures reject with `RemoteError` (`ClientException` is an alias),
preserving the remote payload. `CallTimeoutError`, `ConnectionClosedError`
and `CapacityError` describe local failures. Disconnect rejects pending calls
and aborts the peer's signal. Invalid JSON/identifiers and duplicate in-flight
request IDs close the connection; late replies to aborted calls are ignored.

JSON uses native `JSON.parse`/`JSON.stringify`. Supply `{ codec: { loads,
dumps } }` on both peers to customize it. JSON.stringify semantics apply:
BigInt/cyclic values fail serialization, and embedded byte arrays are not
implicitly converted to Python's base64 representation. Use raw binary frames
or an agreed codec. Async handlers which continue after disconnect cannot send
late replies. Application-level `ping` echoes its parameters; `ws` handles
WebSocket control frames separately.

## Verification and development

```sh
npm run check
npm run test:interop
npm pack --dry-run
```

`test:interop` requires uv and installs its locked Python environment under
`tests/interop/`. It checks both Python clients against this server and this
client against both Python servers, including callbacks and remote errors.
The ASGI version is pinned to a source revision in that lockfile.

The Node suite covers the unchanged original browser client, Node HTTP,
Express, Fastify, concurrent callbacks, route state/policies, auth, payload and
queue limits, malformed messages, errors, timeouts, abort and shutdown.
CI runs Node 22/24/26 on Linux plus Node 24 on Windows/macOS, and a separate
Python interoperability job. The npm artifact includes declarations, source
maps, source and license notices. It contains no Python library implementation.

Licensed under Apache-2.0. The original JavaScript interoperability fixture
retains its MIT license. Contact: orlovdl@gmail.com.
