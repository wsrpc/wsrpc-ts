import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

// Inspect the full bundled graph, including imports preserved only for side effects.
async function bundle(entry, conditions) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    format: "esm",
    conditions,
    write: false,
    metafile: true,
    logLevel: "silent",
    treeShaking: false,
  });
  for (const [path, input] of Object.entries(result.metafile.inputs)) {
    assert.doesNotMatch(
      path.replaceAll("\\", "/"),
      /(^|\/)(node_modules\/ws|lib\/node\.js)(\/|$)/,
    );
    for (const item of input.imports) {
      assert.equal(
        item.external,
        undefined,
        `Unexpected external import: ${item.path}`,
      );
      assert.doesNotMatch(item.path, /^(node:|ws$)/);
    }
  }
  return result;
}
const declarations = execFileSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "-p",
    "tsconfig.workers.json",
    "--listFilesOnly",
  ],
  { encoding: "utf8" },
);
assert.doesNotMatch(
  declarations.replaceAll("\\", "/"),
  /node_modules\/@types\/node\//,
);
const temp = await mkdtemp(join(tmpdir(), "wsrpc-worker-"));
let runtime;
try {
  // Root and explicit core must resolve independently of the browser facade.
  for (const condition of ["workerd", "worker"]) {
    const result = await build({
      stdin: {
        contents: 'export { RPCPeer } from "@wsrpc/client";',
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: "browser",
      format: "esm",
      conditions: [condition],
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs).map((path) =>
      path.replaceAll("\\", "/"),
    );
    assert.ok(inputs.some((path) => path.endsWith("lib/core.js")));
    assert.ok(
      inputs.every(
        (path) =>
          !path.endsWith("lib/index.js") && !path.endsWith("lib/browser.js"),
      ),
    );
  }
  const worker = await bundle("examples/workers/worker.ts", ["workerd"]);
  const scriptPath = join(temp, "worker.mjs");
  await writeFile(scriptPath, worker.outputFiles[0].text);
  runtime = new Miniflare({
    modules: true,
    modulesRoot: temp,
    rootPath: temp,
    scriptPath,
    compatibilityDate: "2026-07-01",
    compatibilityFlags: [],
  });
  const response = await runtime.dispatchFetch("https://example.test/ws/", {
    headers: { Upgrade: "websocket" },
  });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  assert.ok(socket);
  socket.accept();
  let resolveReply;
  const reply = new Promise((resolve) => {
    resolveReply = resolve;
  });
  socket.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.method === "double")
      socket.send(
        JSON.stringify({ id: frame.id, result: frame.params.value * 2 }),
      );
    else resolveReply(frame);
  });
  socket.send(
    JSON.stringify({ id: 3, method: "callback", params: { value: 21 } }),
  );
  const timer = setTimeout(() => resolveReply({ error: "timeout" }), 5000);
  try {
    assert.deepEqual(await reply, { id: 3, result: 42 });
  } finally {
    clearTimeout(timer);
    socket.close();
  }
  console.log(
    "Worker conditions, Node-free module graph, types and workerd bidirectional RPC passed",
  );
} finally {
  await runtime?.dispose();
  await rm(temp, { recursive: true, force: true });
}
