import assert from "node:assert/strict";
import { test } from "node:test";
const { releaseVersion } = await import(
  new URL("../../tools/release-version.mjs", import.meta.url).href
);

test("release versions are canonical and prereleases never replace latest", () => {
  assert.deepEqual(releaseVersion("v1.2.3"), {
    version: "1.2.3",
    channel: "latest",
  });
  assert.deepEqual(releaseVersion("0.1.0"), {
    version: "0.1.0",
    channel: "latest",
  });
  assert.deepEqual(releaseVersion("v1.0.0-rc.1"), {
    version: "1.0.0-rc.1",
    channel: "next",
  });
  assert.deepEqual(releaseVersion("v1.0.0", true), {
    version: "1.0.0",
    channel: "next",
  });
  for (const tag of [
    "",
    "latest",
    "v1.2",
    "v01.2.3",
    "1.2.3-01",
    "1.2.3+build",
    "1.2.3\nchannel=latest",
    "1.2.3;echo bad",
    "99999999999999999999.1.0",
  ]) {
    assert.throws(() => releaseVersion(tag));
  }
});

test("the release version updates both packages and the exact internal dependency", async () => {
  const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { setReleaseVersion } = await import(
    new URL("../../tools/release-version.mjs", import.meta.url).href
  );
  const root = mkdtempSync(join(tmpdir(), "wsrpc-version-"));
  try {
    for (const name of ["client", "server"]) {
      mkdirSync(join(root, "packages", name), { recursive: true });
      writeFileSync(
        join(root, "packages", name, "package.json"),
        JSON.stringify({
          name: `@wsrpc/${name}`,
          version: "4.5.0",
          dependencies: { "@wsrpc/client": "4.5.0" },
        }),
      );
    }
    setReleaseVersion(root, "4.6.0-rc.1");
    for (const name of ["client", "server"]) {
      const meta = JSON.parse(
        readFileSync(join(root, "packages", name, "package.json"), "utf8"),
      );
      assert.equal(meta.version, "4.6.0-rc.1");
      if (name === "server")
        assert.equal(meta.dependencies["@wsrpc/client"], meta.version);
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("publication orders client/server, permits identical retries and rejects conflicting published artifacts", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { publishArtifacts } = await import(
    new URL("../../tools/publish.mjs", import.meta.url).href
  );
  const root = mkdtempSync(join(tmpdir(), "wsrpc-publish-"));
  const items = ["client", "server"].map((name) => ({
    name: `@wsrpc/${name}`,
    version: "4.5.0",
    filename: `wsrpc-${name}-4.5.0.tgz`,
    integrity: `sha512-${name}`,
  }));
  writeFileSync(join(root, "manifest.json"), JSON.stringify(items));
  try {
    const published: string[] = [];
    const missing = () => {
      throw Object.assign(new Error("Not found"), {
        stdout: JSON.stringify({ error: { code: "E404" } }),
      });
    };
    const run = (_cmd: string, args: string[]) => {
      if (args[0] === "view") return missing();
      published.push(args[1]!);
      assert.deepEqual(args.slice(2), [
        "--ignore-scripts",
        "--access",
        "public",
        "--tag",
        "next",
      ]);
      return "";
    };
    publishArtifacts(root, "next", run);
    assert.deepEqual(
      published,
      items.map((item) => join(root, item.filename)),
    );
    published.length = 0;
    publishArtifacts(root, "next", (_cmd: string, args: string[]) =>
      args[0] === "view" && args[1]!.startsWith("@wsrpc/client@")
        ? JSON.stringify(items[0]!.integrity)
        : run(_cmd, args),
    );
    assert.deepEqual(published, [join(root, items[1]!.filename)]);
    assert.throws(
      () => publishArtifacts(root, "latest", () => JSON.stringify("different")),
      /differs/,
    );
    assert.throws(
      () => publishArtifacts(root, "invalid", run),
      /Invalid distribution/,
    );
    assert.throws(
      () =>
        publishArtifacts(root, "latest", () => {
          throw new Error("network failure");
        }),
      /network failure/,
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});
