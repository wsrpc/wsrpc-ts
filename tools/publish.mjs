import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Client first: the server's exact dependency must already exist in npm. */
export function publishArtifacts(directory, channel, run = execFileSync) {
  if (!["latest", "next"].includes(channel))
    throw new Error("Invalid distribution tag");
  const manifest = JSON.parse(
    readFileSync(resolve(directory, "manifest.json"), "utf8"),
  );
  const artifacts = ["@wsrpc/client", "@wsrpc/server"].map((name) => {
    const matches = manifest.filter((item) => item.name === name);
    if (matches.length !== 1)
      throw new Error(`Expected one artifact for ${name}`);
    const item = matches[0];
    if (item.filename !== `wsrpc-${name.split("/")[1]}-${item.version}.tgz`)
      throw new Error("Unexpected artifact filename");
    return item;
  });
  if (artifacts[0].version !== artifacts[1].version)
    throw new Error("Package versions differ");
  for (const item of artifacts) {
    let published;
    try {
      published = JSON.parse(
        run(
          "npm",
          ["view", `${item.name}@${item.version}`, "dist.integrity", "--json"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ),
      );
    } catch (error) {
      let code;
      try {
        code = JSON.parse(String(error.stdout)).error?.code;
      } catch {
        /* Not an npm JSON error. */
      }
      if (code !== "E404") throw error;
    }
    if (published) {
      if (published !== item.integrity)
        throw new Error(
          `Published ${item.name}@${item.version} differs from the tested artifact`,
        );
      console.log(
        `${item.name}@${item.version} already published with matching integrity`,
      );
      continue;
    }
    run(
      "npm",
      [
        "publish",
        resolve(directory, item.filename),
        "--ignore-scripts",
        "--access",
        "public",
        "--tag",
        channel,
      ],
      { stdio: "inherit" },
    );
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  publishArtifacts(process.argv[2] ?? "artifacts", process.argv[3] ?? "latest");
}
