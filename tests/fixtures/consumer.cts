import WSRPC = require("@wsrpc/client");
const browser = new WSRPC("ws://localhost/ws/");
const response: Promise<number> = browser.call<number>("echo", 1);
void response;
