import { RPCPeer } from "@wsrpc/client";
import * as WorkerExports from "@wsrpc/client";
// @ts-expect-error Worker root is explicitly core-only, not the legacy browser constructor
WorkerExports.default;
void RPCPeer;
