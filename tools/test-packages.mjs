import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
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
  const args = [
    "install",
    ...manifest.map((item) => resolve("artifacts", item.filename)),
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
    import { createRequire } from 'node:module';
    if (A !== B || typeof WSRPC !== 'function' || typeof WSRPCClient.connect !== 'function') process.exit(1);
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
