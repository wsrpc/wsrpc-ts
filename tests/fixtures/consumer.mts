import WSRPC from "@wsrpc/client";
import { WSRPCClient } from "@wsrpc/client/node";
import {
  AllowedRoute,
  WebSocketAsync,
  getCurrentSocket,
  proxy,
} from "@wsrpc/server";
const browser = new WSRPC("ws://localhost/ws/");
const response: Promise<number> = browser.call<number>("echo", 1);
class Service extends AllowedRoute {
  constructor(readonly dependency: string) {
    super();
  }
  @proxy method() {
    return this.socket.id + getCurrentSocket().id + this.dependency;
  }
}
WebSocketAsync.addRoute("service", new Service("injected"));
void WSRPCClient;
void response;
