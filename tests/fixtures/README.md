# Original browser client fixtures

`client-4.4.1.mjs` and `client-4.4.1.min.js` are unmodified files extracted
from the published `@wsrpc/client@4.4.1` npm archive, retrieved from
https://registry.npmjs.org/@wsrpc/client/-/client-4.4.1.tgz.
The archive's integrity is
`sha512-UiTW/FS2AQ7Cd+zAN7TAw4+7KqGwJK2pw2PECVGrF4As73qISGonEehqugmnb1XgU5m5A2NogmGPYTeb5vMMDQ==`.
They retain the MIT license in `LICENSE`. Their file contents and formatting
must remain unchanged so tests compare against the shipped release.

`legacy-client.js` is the original source bundled by the Python implementation.
The compatibility tests exercise both old and current clients: public methods,
queued calls, dotted proxies, deferred callbacks, remote failures, events,
raw sends, disconnect rejection and reconnection. Serialized frames are
compared exactly. The published UMD client also connects to the current server.
