import { WSRPCClient } from "@wsrpc/client/node";

const client = await WSRPCClient.connect(
  process.argv[2] ?? "ws://127.0.0.1:8000/ws/",
  {
    routes: new Map([
      ["double", (_socket, { value }: { value: number }) => value * 2],
    ]),
  },
);
try {
  console.log(await client.call("echo", { message: "Hello" }));
  console.log(await client.call("callback", { value: 21 }));
} finally {
  await client.close();
}
