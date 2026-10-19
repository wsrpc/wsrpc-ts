import type WSRPC from "./browser.js" with { "resolution-mode": "import" };
declare const Client: typeof WSRPC;
export = Client;
