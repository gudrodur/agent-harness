// Tests for the heredoc readers in the shared shell-command lib. Gates call
// stripHeredocBodies and heredocBodies on every shell command they judge, so a
// crafted command must not make them slow or make them throw: a gate that
// stalls or crashes is a gate that is skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { heredocBodies, stripHeredocBodies } from "../../engine/lib/shell-command.mjs";

test("stripHeredocBodies keeps head lines and drops bodies, several tags on a line in order", () => {
  assert.equal(stripHeredocBodies("cat > f <<EOF\nbody\nEOF\nls"), "cat > f <<EOF\nls");
  assert.equal(stripHeredocBodies("cat <<'A' <<\"B\"\na\nB\nA\nb\nB\nnext"), "cat <<'A' <<\"B\"\nnext");
  assert.equal(stripHeredocBodies("cat <<-  X\n\tx\n\tX\nafter"), "cat <<-  X\nafter");
  // A tag that never closes keeps the rest a body.
  assert.equal(stripHeredocBodies("cat <<EOF\nbody\nmore"), "cat <<EOF");
  // After every tag closed, a later line opens new ones.
  assert.equal(stripHeredocBodies("a <<X\nx\nX\nb <<Y\ny\nY\nc"), "a <<X\nb <<Y\nc");
});

test("heredocBodies pairs each tag with its head line and body, unclosed ones included", () => {
  assert.deepEqual(heredocBodies("cat <<A <<B\na\nA\nb1\nb2\nB\nls <<C\nc"), [
    { head: "cat <<A <<B", tag: "A", body: "a" },
    { head: "cat <<A <<B", tag: "B", body: "b1\nb2" },
    { head: "ls <<C", tag: "C", body: "c" },
  ]);
});

// One line holding many openers, then their terminators. A 1 MB command holds
// about 250 000 `<<A ` openers.
const openers = (n) => `cat ${"<<A ".repeat(n)}\n${"A\n".repeat(n)}ls`;

test("a line with 250 000 heredoc openers neither throws nor keeps a body", () => {
  const command = openers(250_000);
  assert.equal(stripHeredocBodies(command), `cat ${"<<A ".repeat(250_000)}\nls`);
  const bodies = heredocBodies(command);
  assert.equal(bodies.length, 250_000);
  assert.ok(bodies.every((b) => b.tag === "A" && b.body === ""));
});

// Growth, not speed: the time for 16n openers over the time for n. Linear work
// reads about 16, quadratic about 256; the bound sits between. Medians of
// interleaved runs, best of three attempts, so a burst of load on a shared
// runner cannot fail a linear walk while a quadratic one fails every time.
const median = (fn, input) => {
  fn(input);
  const times = [];
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    fn(input);
    times.push(performance.now() - t0);
  }
  return times.sort((x, y) => x - y)[2];
};
const growth = (fn) => {
  const small = openers(8_000);
  const large = openers(128_000);
  let best = Infinity;
  for (let attempt = 0; attempt < 3 && best >= 48; attempt++) {
    best = Math.min(best, median(fn, large) / Math.max(median(fn, small), 0.05));
  }
  return best;
};

for (const [name, fn] of [["stripHeredocBodies", stripHeredocBodies], ["heredocBodies", heredocBodies]]) {
  test(`${name} grows linearly with the number of heredoc openers on one line`, () => {
    const ratio = growth(fn);
    assert.ok(ratio < 48, `16x the openers took ${ratio.toFixed(1)}x the time`);
  });
}
