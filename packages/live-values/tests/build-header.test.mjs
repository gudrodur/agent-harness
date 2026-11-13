// The generated dist/ ships into other repos, so its header must name no
// repository slug or URL, and dist/ must match what build.mjs produces.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { DIST, build } from "../build.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SLUG_URL = /github\.com\/[\w.-]+\/[\w.-]+/;

test("build header names no repository slug or URL", () => {
  const header = build(ROOT).split("\n").slice(0, 6).join("\n");
  assert.match(header, /^(#!.*\n)?\/\/ GENERATED from live-values@/);
  assert.doesNotMatch(header, SLUG_URL);
});

test("committed dist carries no repository URL and equals a fresh build", () => {
  const dist = fs.readFileSync(`${ROOT}/${DIST}`, "utf8");
  assert.doesNotMatch(dist.split("\n").slice(0, 6).join("\n"), SLUG_URL);
  assert.equal(dist, build(ROOT));
});
