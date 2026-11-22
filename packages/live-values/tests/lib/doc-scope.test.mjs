// Tests for the shared doc scope. Two gates here decide what a reader of the
// prose may trust. Each is shown both ways: it fires on its defect and stays
// quiet on the legitimate neighbour.
//  - autogenMask: whether a line is generated. The loose prefix regex it
//    replaced let a table cell that QUOTES the markers close the block, so the
//    106 rows after it read as hand-written.
//  - checkQuerySegments: whether a command can run on a CI runner with no
//    auth. The first-word gate passed a `gh` hidden behind a pipe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { autogenMask, checkLocal, checkQuerySegments, runCommand } from "../../engine/lib/doc-scope.mjs";

const mask = (text) => autogenMask(text.split("\n"));

test("a whole-line block masks its markers and body, and nothing outside", () => {
  assert.deepEqual(
    mask(["before", "<!-- AUTO-GEN:start t -->", "row", "<!-- AUTO-GEN:end t -->", "after"].join("\n")),
    [false, true, true, true, false],
  );
});

test("a row that quotes both markers keeps later rows inside the block", () => {
  const lines = [
    "<!-- AUTO-GEN:start scripts-table -->",
    "| `doc-gen.mjs` | node | Looks for <!-- AUTO-GEN:start <name> --> ... <!-- AUTO-GEN:end <name> --> blocks |",
    "| later row |",
    "<!-- AUTO-GEN:end scripts-table -->",
    "hand-written",
  ];
  assert.deepEqual(autogenMask(lines), [true, true, true, true, false]);
  // The old reader: an unanchored end test on each line after the start.
  let auto = false;
  const old = lines.map((l) => {
    if (/<!--\s*AUTO-GEN:start/.test(l)) auto = true;
    const inside = auto;
    if (/<!--\s*AUTO-GEN:end/.test(l)) auto = false;
    return inside;
  });
  assert.equal(old[2], false, "the old regex really did leak the later row out of the block");
});

test("an end marker of another name does not close the block", () => {
  assert.deepEqual(
    mask(["<!-- AUTO-GEN:start a -->", "<!-- AUTO-GEN:end b -->", "x", "<!-- AUTO-GEN:end a -->", "y"].join("\n")),
    [true, true, true, true, false],
  );
});

test("an unterminated block runs to the end of the file", () => {
  assert.deepEqual(mask(["<!-- AUTO-GEN:start a -->", "x", "y"].join("\n")), [true, true, true]);
});

test("a stray end marker with no open block is ordinary text", () => {
  assert.deepEqual(mask(["<!-- AUTO-GEN:end a -->", "x"].join("\n")), [false, false]);
});

test("checkQuerySegments passes an all-local pipeline", () => {
  assert.deepEqual(checkQuerySegments(`jq '.servers|length' servers.json | wc -l`), { ok: true });
  assert.deepEqual(checkQuerySegments(`grep -c x a.md && cat b.md; git ls-files '*.md' | wc -l`), { ok: true });
});

test("checkQuerySegments and checkLocal both refuse a non-local command after a pipe", () => {
  const run = `jq ".servers|length" servers.json | gh api repos/x`;
  assert.deepEqual(checkLocal(run, "/"), { ok: false, reason: "tool not local: gh (network)" });
  assert.deepEqual(checkQuerySegments(run), { ok: false, reason: "command not allowed: gh", word: "gh" });
});

test("checkQuerySegments gates command substitutions, but not quoted text", () => {
  assert.equal(checkQuerySegments(`wc -l $(gcloud secrets list)`).word, "gcloud");
  assert.equal(checkQuerySegments("cat `curl -s x`").word, "curl");
  assert.deepEqual(checkQuerySegments(`grep -c 'gh api | curl $(x)' a.md`), { ok: true });
});

test("checkQuerySegments reads through compound-command keywords", () => {
  assert.deepEqual(checkQuerySegments(`for f in a b; do wc -l "$f"; done`), { ok: true });
  assert.equal(checkQuerySegments(`for f in a b; do curl "$f"; done`).word, "curl");
  assert.equal(checkQuerySegments(`if gh auth status; then cat x; fi`).word, "gh");
});

test("checkQuerySegments takes a caller's allowlist", () => {
  assert.deepEqual(checkQuerySegments(`awk '{n++} END{print n}' a.md`, new Set(["awk"])), { ok: true });
  assert.equal(checkQuerySegments(`awk 1 a.md`).word, "awk");
});

test("runCommand's failure carries the whole stdout and stderr as raw, beyond the 200-character output", () => {
  const bad = runCommand("i=0; while [ $i -lt 100 ]; do echo line-$i; i=$((i+1)); done; echo oops >&2; exit 2", { root: "/", timeoutMs: 5000 });
  assert.equal(bad.ok, false);
  assert.ok(bad.output.length <= 210);
  assert.match(bad.raw, /line-0\n/);
  assert.match(bad.raw, /line-99\n[\s\S]*oops/);
  const noisy = runCommand("echo out; echo warn >&2", { root: "/", timeoutMs: 5000, failOnStderr: true });
  assert.equal(noisy.ok, false);
  assert.match(noisy.raw, /out\n[\s\S]*warn/);
  const dead = runCommand("echo seen; (exit 3) | true", { root: "/", timeoutMs: 5000, deadStages: true });
  assert.equal(dead.ok, false);
  assert.match(dead.raw, /seen/);
});

test("runCommand returns stdout, and a failure as text that is never empty", () => {
  assert.deepEqual(runCommand("printf 7", { root: "/", timeoutMs: 5000 }), { ok: true, stdout: "7" });
  const bad = runCommand("exit 3", { root: "/", timeoutMs: 5000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.timedOut, false);
  assert.ok(bad.output.length > 0);
  const slow = runCommand("sleep 5", { root: "/", timeoutMs: 200 });
  assert.equal(slow.timedOut, true);
  assert.match(slow.output, /^timed out after 200 ms/);
});

test("liveScope adds a project's tracked agent docs, never untracked files, INDEX.md or symlinks", async () => {
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { liveScope } = await import("../../engine/lib/doc-scope.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-scope-"));
  try {
    const put = (p, s = "x\n") => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
    for (const p of ["CLAUDE.md", "README.md", "docs/deep/nested.md", ".claude/skills/a/SKILL.md", "docs/INDEX.md", "src/notes.md"]) put(p);
    fs.mkdirSync(path.join(root, "vendor/b"), { recursive: true });
    fs.writeFileSync(path.join(root, "vendor/b/SKILL.md"), "x\n");
    fs.symlinkSync(path.join(root, "vendor/b"), path.join(root, ".claude/skills/b"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "add", "-A"]);
    put("docs/untracked.md");
    const got = liveScope(root).map((a) => path.relative(root, a)).sort();
    assert.deepEqual(got, [".claude/skills/a/SKILL.md", "CLAUDE.md", "README.md", "docs/deep/nested.md"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkLocal gates every segment and substitution, with per-tool argument rules", () => {
  assert.equal(checkLocal("grep -c x README.md | wc -l", "/").ok, true);
  assert.match(checkLocal("node -e 'process.exit(0)'", "/").reason, /node only runs scripts/);
  assert.match(checkLocal("echo hi > out.txt", "/").reason, /writes a file/);
  assert.equal(checkLocal("echo hi 2>&1", "/").ok, true);
  assert.match(checkLocal("git push origin main", "/").reason, /not a read subcommand/);
  assert.match(checkLocal("git -c core.pager=x log", "/").reason, /git flag can run or write/);
  assert.match(checkLocal("find . -delete", "/").reason, /find action/);
  assert.match(checkLocal("sed -i s/a/b/ f", "/").reason, /sed only/);
  assert.match(checkLocal("wc -l $(curl -s x)", "/").reason, /curl \(network\)/);
  assert.match(checkLocal("podman ps $(seq 3)", "/").reason, /podman \(container\)/);
});

test("checkQuerySegments reads the command past exec options, not the -a name", () => {
  assert.deepEqual(checkQuerySegments("exec -a ugrep grep -c x a.md"), { ok: true });
  assert.deepEqual(checkQuerySegments("exec -a name gh api x"), { ok: false, reason: "command not allowed: gh", word: "gh" });
});

test("runCommand failOnStderr: exit 0 with stderr is not ok; without the option it is", () => {
  const run = 'echo x >&2; printf 7';
  assert.deepEqual(runCommand(run, { root: ".", timeoutMs: 5000 }), { ok: true, stdout: "7" });
  const r = runCommand(run, { root: ".", timeoutMs: 5000, failOnStderr: true });
  assert.equal(r.ok, false);
  assert.match(r.output, /^stderr: x/);
});

test("runCommand deadStages: exit 2+ on an earlier stage is dead; exit 1 and SIGPIPE are not", () => {
  const opts = { root: ".", timeoutMs: 5000, deadStages: true };
  const dead = runCommand("sh -c 'exit 2' | wc -w", opts);
  assert.equal(dead.ok, false);
  assert.match(dead.output, /stage 1 \(sh\) exited 2/);
  const compound = runCommand("for i in 1; do sh -c 'exit 3'; done | wc -w", opts);
  assert.equal(compound.ok, false);
  assert.match(compound.output, /^stage 1 exited 3/, "no keyword label");
  assert.equal(runCommand("false | wc -w", opts).ok, true, "exit 1 is not death");
  assert.equal(runCommand("printf a | grep zzz | wc -l", opts).ok, true);
  assert.equal(runCommand("awk 'END{exit !f}' </dev/null | wc -l", opts).ok, true);
  assert.equal(runCommand("for i in 1 2; do test -f nope; done | wc -l", opts).ok, true);
  assert.equal(runCommand("yes | head -1 | wc -l", opts).ok, true, "SIGPIPE 141");
  assert.equal(runCommand("printf 'a b' | wc -w", opts).stdout.trim(), "2");
  assert.equal(runCommand("sh -c 'exit 2' | wc -w", { root: ".", timeoutMs: 5000 }).ok, true, "off unless asked");
});
