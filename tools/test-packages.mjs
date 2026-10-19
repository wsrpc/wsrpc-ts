import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const project = mkdtempSync(join(tmpdir(), "wsrpc-consumer-"));
try {
  writeFileSync(
    join(project, "package.json"),
    '{"private":true,"type":"module"}',
  );
  const manifest = JSON.parse(readFileSync("artifacts/manifest.json", "utf8"));
  function install(packages) {
    const args = [
      "install",
      ...packages,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ];
    if (process.env.npm_execpath)
      execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
        cwd: project,
        stdio: "inherit",
      });
    else execFileSync("npm", args, { cwd: project, stdio: "inherit" });
  }
  const client = manifest.find((item) => item.name === "@wsrpc/client");
  install([resolve("artifacts", client.filename)]);
  for (const dependency of ["ws", "@types/ws", "@types/node"]) {
    assert.equal(
      existsSync(join(project, "node_modules", dependency)),
      false,
      `Browser install must not pull ${dependency}`,
    );
  }
  writeFileSync(
    join(project, "browser.mts"),
    `
    import WSRPC from '@wsrpc/client';
    import { RPCPeer } from '@wsrpc/client/core';
    const rpc = new WSRPC('ws://localhost/ws/');
    const value: Promise<number> = rpc.call<number>('echo', 1);
    void value; void RPCPeer;
    // @ts-expect-error browser consumers must not inherit Node globals
    process.cwd();
  `,
  );
  writeFileSync(
    join(project, "tsconfig.browser.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2023",
        module: "NodeNext",
        types: [],
        lib: ["ES2023", "DOM"],
      },
      files: ["browser.mts"],
    }),
  );
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "-p",
      "tsconfig.browser.json",
    ],
    { cwd: project, stdio: "inherit" },
  );
  // Node-only client installs its optional transport and declaration dependencies explicitly.
  install(["ws@^8.22.0", "@types/ws@^8.18.1", "@types/node@^22"]);
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { WSRPCClient } from '@wsrpc/client/node'; if (typeof WSRPCClient.connect !== 'function') process.exit(1)",
    ],
    { cwd: project, stdio: "inherit" },
  );
  install(
    manifest
      .filter((item) => item.name !== "@wsrpc/client")
      .map((item) => resolve("artifacts", item.filename)),
  );
  for (const file of ["consumer.mts", "consumer.cts"])
    copyFileSync(join(root, "tests/fixtures", file), join(project, file));
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--strict",
      "--noEmit",
      "--target",
      "ES2023",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "consumer.mts",
      "consumer.cts",
    ],
    { cwd: project, stdio: "inherit" },
  );
  // Executing from the temporary project prevents workspace symlinks from masking missing files/dependencies.
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import WSRPC from '@wsrpc/client';
    import { WSRPCClient } from '@wsrpc/client/node';
    import { RPCPeer as A } from '@wsrpc/client/core';
    import { RPCPeer as B } from '@wsrpc/server';
    import { RPCPeer as C } from '@wsrpc/server/core';
    import { createRequire } from 'node:module';
    if (A !== B || A !== C || typeof WSRPC !== 'function' || typeof WSRPCClient.connect !== 'function') process.exit(1);
    if (typeof createRequire(import.meta.url)('@wsrpc/client') !== 'function') process.exit(1);
    console.log('Packed client/server imports, class identity and declarations passed');
  `,
    ],
    { cwd: project, encoding: "utf8" },
  );
  assert.match(output, /passed/);
  console.log(output.trim());
} finally {
  rmSync(project, { recursive: true, force: true });
}
