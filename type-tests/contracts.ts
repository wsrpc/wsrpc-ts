import type {
  RPCPeer,
  Handler,
  TypedProxy,
  CallOptions,
  Routes,
} from "@wsrpc/server";
import { AllowedRoute, WebSocketAsync, Signal } from "@wsrpc/server";
import { WSRPCClient } from "@wsrpc/client/node";

interface Contract {
  echo(params: { value: number }): { value: number };
  asynchronous(params: { id: string }): Promise<{ found: boolean }>;
  optional(params?: { count: number }): number;
  ping(): boolean;
  nested: { increment(params: { by: number }): number };
  unsupported(a: number, b: number): number;
  data: string;
}
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
export type ResponseIsNotAny = Assert<
  Equal<ReturnType<TypedProxy<Contract>["echo"]>, Promise<{ value: number }>>
>;
export type AsyncIsUnwrapped = Assert<
  Equal<
    ReturnType<TypedProxy<Contract>["asynchronous"]>,
    Promise<{ found: boolean }>
  >
>;
export type DataIsNotCallable = Assert<
  Equal<TypedProxy<Contract>["data"], never>
>;

export async function checked(peer: RPCPeer) {
  const remote = peer.remote<Contract>();
  const options: CallOptions = {
    timeout: 50,
    signal: new AbortController().signal,
  };
  const value: number = (await remote.echo({ value: 1 }, options)).value;
  const found: boolean = (await remote.asynchronous({ id: "x" })).found;
  const result: number = await remote.nested.increment({ by: 2 });
  const optional: number = await remote.optional();
  const optionalWithOptions: number = await remote.optional(undefined, options);
  const pong: boolean = await remote.ping();
  await remote.ping(undefined, options);
  // @ts-expect-error missing required parameter
  remote.echo();
  // @ts-expect-error parameter property has the wrong type
  remote.echo({ value: "bad" });
  // @ts-expect-error unknown nested method
  remote.nested.decrement({ by: 1 });
  // @ts-expect-error unknown top-level method
  remote.missing({});
  // @ts-expect-error excess property on parameter literal
  remote.echo({ value: 1, secret: true });
  // @ts-expect-error the return value is not a string
  const bad: string = await remote.nested.increment({ by: 1 });
  // @ts-expect-error async result is a concrete object, not any
  (await remote.asynchronous({ id: "x" })).missing;
  // @ts-expect-error wrong timeout type
  remote.echo({ value: 1 }, { timeout: "slow" });
  // @ts-expect-error wire methods accept one params value, not two positional arguments
  remote.unsupported(1, 2);
  // @ts-expect-error a contract property cannot be invoked as an RPC method
  remote.data();
  // @ts-expect-error a contract must be an object
  peer.remote<number>();
  void bad;
  return { value, found, result, optional, optionalWithOptions, pong };
}

const handler: Handler<{ value: number }, number> = function (
  socket,
  { value },
) {
  const self: RPCPeer = this;
  void self;
  void socket;
  return value * 2;
};
// @ts-expect-error result must satisfy the registered handler's generic type
const badHandler: Handler<{ value: number }, number> = () => "wrong";
const routes: Routes = new Map([["double", handler]]);
export async function clientContract() {
  const client = await WSRPCClient.connect("ws://localhost/ws/", { routes });
  const number: number = await client
    .remote<Contract>()
    .nested.increment({ by: 1 });
  await client.close();
  return number;
}
class Ready extends AllowedRoute {
  constructor(readonly database: { name: string }) {
    super();
  }
  value() {
    return this.database.name;
  }
}
WebSocketAsync.addRoute("ready", new Ready({ name: "injected" }));
class PerConnection extends AllowedRoute {}
WebSocketAsync.addRoute("class", PerConnection);
// @ts-expect-error a class needing application dependencies must be registered as a prepared instance
WebSocketAsync.addRoute("needsDependency", Ready);
WebSocketAsync.addRoute("unrestricted", {
  // @ts-expect-error ordinary objects must explicitly opt in to a Route exposure policy
  constructor: () => {},
  secret: () => 1,
});
const signal = new Signal<{ value: number }>();
signal.connect(({ value }) => {
  const result: number = value;
  void result;
});
// @ts-expect-error event payload is checked
signal.emit({ value: "bad" });
void badHandler;

import WSRPC from "@wsrpc/client";
import type { BrowserClient } from "@wsrpc/client";
const browser: BrowserClient<Contract> = new WSRPC<Contract>(
  "ws://localhost/ws/",
);
const browserValue: Promise<{ value: number }> = browser.proxy.echo(
  { value: 1 },
  { noWait: true },
);
// @ts-expect-error browser remote arguments are checked
browser.proxy.echo({ value: "bad" });
// @ts-expect-error browser client options differ from Node timeout options
browser.proxy.echo({ value: 1 }, { timeout: 10 });
// @ts-expect-error browser result is a concrete value, not any
const wrongBrowserResult: Promise<string> = browser.proxy.echo({ value: 1 });
void browserValue;
void wrongBrowserResult;
