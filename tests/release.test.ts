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
