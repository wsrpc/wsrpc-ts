import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("artifacts", { recursive: true });
const args = [
  "pack",
  "--workspaces",
  "--ignore-scripts",
  "--pack-destination",
  "artifacts",
  "--json",
];
const output = process.env.npm_execpath
  ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
      encoding: "utf8",
    })
  : execFileSync("npm", args, { encoding: "utf8" });
writeFileSync("artifacts/manifest.json", output);
for (const item of JSON.parse(output))
  console.log(`${item.name}@${item.version}: ${item.filename}`);
