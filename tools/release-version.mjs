import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Accept canonical npm versions, optionally prefixed with a lowercase v. */
export function releaseVersion(tag, prerelease = false) {
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      version,
    );
  if (
    !match ||
    match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part))) ||
    match[4]
      ?.split(".")
      .some(
        (part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"),
      )
  ) {
    throw new Error(
      "Release tag must be X.Y.Z or vX.Y.Z, optionally with a SemVer prerelease suffix",
    );
  }
  return { version, channel: prerelease || match[4] ? "next" : "latest" };
}

/** Stamp both packages and their internal dependency before creating artifacts. */
export function setReleaseVersion(root, version) {
  for (const name of ["client", "server"]) {
    const file = resolve(root, "packages", name, "package.json");
    const meta = JSON.parse(readFileSync(file, "utf8"));
    meta.version = version;
    if (name === "server") meta.dependencies["@wsrpc/client"] = version;
    writeFileSync(file, JSON.stringify(meta, null, 2) + "\n");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const meta = releaseVersion(
    process.env.RELEASE_TAG ?? "",
    process.env.RELEASE_PRERELEASE === "true",
  );
  setReleaseVersion(process.cwd(), meta.version);
  execFileSync(
    "npm",
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { stdio: "inherit" },
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${meta.version}\nchannel=${meta.channel}\n`,
    );
  }
}
