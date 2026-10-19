# wsrpc-ts

Bidirectional WebSocket RPC for Node.js and TypeScript. It uses the WSRPC
protocol shared by `wsrpc-aiohttp`, `wsrpc-asgi` and the original browser
client. Both ends can expose methods and call each other over one connection.

This repository contains two npm packages:

| Package         | Purpose                                                                         |
| --------------- | ------------------------------------------------------------------------------- |
| `@wsrpc/client` | Existing MIT browser client, plus the typed Node client at `@wsrpc/client/node` |
| `@wsrpc/server` | ESM Node.js 22+ server with HTTP, Express and Fastify integration               |

The client is imported from [wsrpc-js-client](https://github.com/wsrpc/wsrpc-js-client)
with its complete Git history and original browser source. CommonJS, the ESM
module, classic script `WSRPC` global and existing distribution paths remain
available. The shared protocol lives in `@wsrpc/client/core`; the server
re-exports its route classes, errors and types. Both packages use version 4.5.0,
continuing the existing client's published 4.4.1 series.

## Choose an import

| Import               | Purpose                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `@wsrpc/client`      | Original browser constructor (ESM default or CommonJS)                                          |
| `@wsrpc/client/core` | Portable RPCPeer, routes and protocol types for Workers, Deno, Bun or native browser transports |
| `@wsrpc/client/node` | Optional Node.js client using `ws`                                                              |
| `@wsrpc/server`      | Node HTTP upgrade adapter and server API                                                        |
| `@wsrpc/server/core` | Exact compatibility alias of `@wsrpc/client/core`, without loading the Node adapter             |

Use the client package directly for new portable applications. Installing the
server package is intended for Node applications. Packaging and condition
resolution are described in [the development guide](DEVELOPMENT.md).

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
create both npm artifacts and install them in another application:

```sh
npm run pack
# In your application directory:
npm install /path/to/wsrpc-ts/artifacts/wsrpc-client-4.5.0.tgz /path/to/wsrpc-ts/artifacts/wsrpc-server-4.5.0.tgz
```

After publication, use `npm install @wsrpc/client @wsrpc/server`.

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
import { WSRPCClient } from "@wsrpc/client/node";

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

You can also register an already initialized Route object, including its
application dependencies. Omit the socket argument when creating a shared object:

```typescript
import { AllowedRoute, getCurrentSocket } from "@wsrpc/server";

class Service extends AllowedRoute {
  constructor(readonly prefix: string) {
    super();
  }
  async echo(params: { value: number }) {
    const peer = this.socket;
    await Promise.resolve();
    // The same peer remains current after await, even across concurrent clients.
    return { prefix: this.prefix, value: params.value, connection: peer.id };
  }
}

// RPC.addRoute("service", new Service("configured"));
// Helpers called from a route can use getCurrentSocket() without a socket argument.
function currentConnection() {
  return getCurrentSocket().id;
}
```

A registered instance shares its application state across connections. The library
does not overwrite its socket field: `this.socket` uses Node AsyncLocalStorage
for the current call. `getCurrentSocket()` and `getCurrentCall()` expose the same
context to ordinary helper functions. They throw outside a request/lifecycle
context. Plain function handlers also receive the peer as their `this` binding;
arrow functions use the explicit socket argument instead. `_onClose()` runs once
per connection that used an object, with that connection's context. Shared
application resources must therefore be disposed by the application, rather than
by a connection close hook. Do not retain an ambient context past the request's
lifetime.

Each connection lazily creates its own route instance. Calling `counter`
invokes `init` explicitly; `counter.add` invokes `add` without implicitly
calling `init`. `AllowedRoute`/`WebSocketRoute` expose public prototype methods.
Private names, constructors, getters, instance fields and Object methods are
excluded. Use `noproxy(Counter.prototype.someMethod)` to mask a public method.
`Route` exposes an explicit static `methods` set or methods marked with `@proxy`; `PrefixRoute` exposes
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
npm run test:types
npm run test:interop
npm run test:packages
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

The server is licensed under Apache-2.0; the client retains its MIT license. Contact: orlovdl@gmail.com.

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
This is observation only: return values are ignored and Promises are never
awaited. The metadata object is frozen; mutable binary payloads are copied so
an observer cannot change transport data. Synchronous exceptions and rejected
Promises are reported to `console.error` and do not affect RPC dispatch, even
if error reporting itself fails.
`WSRPC.DEBUG` and `WSRPC.TRACE` retain their original boolean behavior.

## Workers and other WebSocket runtimes

Use `@wsrpc/client/core` for a transport-independent peer in Workers, Deno or
Bun. The host supplies the WebSocket transport.

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

## Publishing releases

The `publish.yml` workflow runs when a **GitHub Release is published**, just
like the Python repositories. A tag push alone does not publish. The workflow
checks out the release tag, derives the npm version from `v4.5.0` or `4.5.0`,
runs the full checks and Python interoperability, and publishes the tested client artifact before the server artifact. Both receive
the tag version, including the server dependency on the client. The version changes only inside CI: no version commit or new tag is
created. Tags may include SemVer prerelease suffixes such as `v1.2.3-rc.1`.
Prerelease versions and releases marked prerelease use `next`; stable releases
use `latest`. Build metadata suffixes are not used as npm release versions.

Publishing uses GitHub OIDC with npm CLI 11.19.1 and the `npm` GitHub
environment. Set up the npm trusted publisher for **each package** once:

| Setting           | Value                               |
| ----------------- | ----------------------------------- |
| Packages          | `@wsrpc/client` and `@wsrpc/server` |
| GitHub owner      | `wsrpc`                             |
| Repository        | `wsrpc-ts`                          |
| Workflow filename | `publish.yml`                       |
| Environment       | `npm`                               |
| Allowed action    | Enable direct `npm publish`         |

For a brand-new package, initialize it from an authenticated npm maintainer
account before configuring its package settings. That account needs access
to the `@wsrpc` scope. Subsequent releases use OIDC without a stored npm token.
No npm package, release or tag is created by the local checks.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for
account configuration. Publish a fresh version after that connection is set
up; npm does not allow an existing name/version to be overwritten.

An interrupted publication can be rerun: an already published package is skipped
only if its registry integrity matches the tested archive. A different artifact
with the same name and version fails the workflow. npm publication of two
packages is sequential, so it is not atomic.

`test:types` uses strict `tsc --noEmit` with library declaration checking
and expected compiler errors. It covers nested remote contracts, async results,
optional/no-argument calls, browser constructor generics, handler `this`, prepared
routes and typed signals. CI checks declarations with TypeScript 5.9 and 7.
The packed-package test also compiles separate ESM and CommonJS consumers from
a clean temporary install, without `skipLibCheck`.
