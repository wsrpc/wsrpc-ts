# Developing WSRPC

## Browser compatibility

The compatibility contract is existing application JavaScript written for
`@wsrpc/client@4.4.1`, running against the updated client. The server is a first
release and its source API is not part of that compatibility contract. It must
continue to speak the same wire protocol.

`tests/fixtures/legacy-application.html` runs unchanged against the original npm
4.4.1 UMD bundle and the current bundle. Only the served library file changes.
The test checks queued calls, dotted proxies, synchronous/deferred callbacks,
errors, binary sends, events and reconnects. Source/UMD differential tests also
compare exact serialized messages and the original fixtures' checksums.

```sh
npm ci
npm run check
npx playwright install chromium
npm run test:browser
npm run test:packages
npm run test:interop
```

CI and release builds run the browser compatibility gate before publication.

## Package boundaries

The browser/client package has no runtime dependencies. `ws` is an optional
peer used only by `@wsrpc/client/node`; Node TypeScript consumers install
`@types/ws` and `@types/node` explicitly. The Node-only server carries its own
transport/declaration dependencies. A packed-package test installs the client
alone in a clean browser project, checks its complete dependency tree and
compiles its declarations without Node globals. It separately installs and
checks Node ESM/CommonJS consumers without skipLibCheck.

The ordinary client root contains only the legacy browser facade, so importing
the old constructor does not load modern core syntax or Node adapters.
`@wsrpc/client/core` is the stable, explicit portable entry point. `workerd` and
`worker` conditions on the root resolve to that same core and intentionally do
not supply the browser default constructor. Both JavaScript and declaration
resolution are checked. The `@wsrpc/server/core` path is an exact alias kept for
convenience; graph and identity checks ensure it never loads the server adapter.

The core remains independent of Node imports. `npm run test:workers` bundles
the full graph for a browser platform, checks selected conditions and Worker
declarations, and runs the real Worker example in Miniflare/workerd without
Node compatibility flags. The Miniflare dev dependency's sharp/undici versions
are overridden to patched compatible releases because its pinned transitive
versions had advisories. These tools do not enter published runtime trees.

The legacy browser implementation is deliberately independent of RPCPeer.
`onFrame` observes application payloads without changing serialization or
legacy state/connection behavior. It must never become an interceptor: send
happens first, return values are ignored, and observer Promises are never
awaited. Mutable binary payloads are copied; observer failures and errors in
error reporting are isolated. The website relies on broken frame rendering
leaving the RPC connection operational. Keep the
legacy application's compatibility gate green when editing it.
