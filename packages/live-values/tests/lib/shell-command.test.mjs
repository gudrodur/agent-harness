// Tests for the heredoc readers in the shared shell-command lib. Gates call
// stripHeredocBodies and heredocBodies on every shell command they judge, so a
// crafted command must not make them slow or make them throw: a gate that
// stalls or crashes is a gate that is skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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
    { head: "cat <<A <<B", tag: "A", body: "a", quoted: false },
    { head: "cat <<A <<B", tag: "B", body: "b1\nb2", quoted: false },
    { head: "ls <<C", tag: "C", body: "c", quoted: false },
  ]);
});

// `<<<word` is a herestring: its word sits on the same line and no body follows.
test("a herestring opens no heredoc, beside a real one too", () => {
  assert.equal(stripHeredocBodies("cat <<<word\nnext"), "cat <<<word\nnext");
  assert.equal(stripHeredocBodies("cat <<< word\nnext"), "cat <<< word\nnext");
  assert.equal(stripHeredocBodies("cat <<<word <<EOF\nbody\nEOF\nnext"), "cat <<<word <<EOF\nnext");
  assert.deepEqual(heredocBodies("tr a b <<<word\nnext"), []);
});

// `<<\EOF` quotes the delimiter as `<<'EOF'` does: the body is data and ends at `EOF`.
test("a backslash-quoted delimiter opens a quoted heredoc", () => {
  assert.equal(stripHeredocBodies("cat <<\\EOF\n$(rm x)\nEOF\nnext"), "cat <<\\EOF\nnext");
  assert.equal(stripHeredocBodies("cat <<-\\EOF\n\tbody\n\tEOF\nnext"), "cat <<-\\EOF\nnext");
  assert.deepEqual(heredocBodies("cat <<\\EOF\nb\nEOF"), [{ head: "cat <<\\EOF", tag: "EOF", body: "b", quoted: true }]);
});

test("heredocBodies says whether the delimiter is quoted, so the shell leaves the body unexpanded", () => {
  assert.deepEqual(
    heredocBodies("cat <<'A' <<\"B\" <<C <<-  'D'\na\nA\nb\nB\nc\nC\nd\nD").map((h) => [h.tag, h.quoted]),
    [["A", true], ["B", true], ["C", false], ["D", true]],
  );
});

// An opener counts only where bash sees one. Read inside a quote, a comment or
// arithmetic, it would hide every later line from the gates (round 1 of #44).
test("a `<<` inside quotes, a comment or arithmetic opens no heredoc", () => {
  for (const head of [
    "printf 'a<<\\n'",
    'echo -e "x<<\\tb"',
    "printf 'a<<EOF'",
    'echo "a <<EOF"',
    "echo $'it\\'s <<EOF'",
    "# note <<\\EOF",
    "ls # see <<EOF",
    "x=$((a<<b))",
    "(( x = a << b ))",
    'echo "${x:-<<EOF}"',
    'echo "abc <<EOF',
    "x=`cat <<EOF",
  ]) {
    const command = `${head}\nrm -rf x\nb\nEOF\nls`;
    assert.equal(stripHeredocBodies(command), command, head);
    assert.deepEqual(heredocBodies(command), [], head);
  }
});

// `$[…]` and a subscript are arithmetic: `a[1<<2]=3` shifts. Main kept these
// lines because it took only an identifier as the delimiter; reading the
// whole word, `2]=3` would end the body nowhere and hide every later line
// (round 2 of #44). After `declare` or as a plain argument bash does read a
// heredoc there; keeping its body visible to the gates is the safe side.
test("a `<<` inside `$[…]` or an array subscript opens no heredoc", () => {
  for (const head of [
    "echo $[1<<2]",
    'echo "$[1<<2]"',
    "a[1<<2]=3",
    "a[1<<2]+=3",
    "x=1 a[1<<2]=3",
    "a[$((1))<<2]=3",
    "a[b[1]<<2]=3",
    "echo ${a[1<<2]}",
    "f() { a[1<<2]=3; }; f",
    "declare a[1<<2]=3",
  ]) {
    const command = `${head}\necho RAN\n2\nls`;
    assert.equal(stripHeredocBodies(command), command, head);
    assert.deepEqual(heredocBodies(command), [], head);
  }
  // After the `]` the line is a command line again.
  assert.equal(stripHeredocBodies("a[1<<2]=3 cat <<EOF\nb\nEOF\nls"), "a[1<<2]=3 cat <<EOF\nls");
  assert.equal(stripHeredocBodies("echo $[1<<2] <<EOF\nb\nEOF\nls"), "echo $[1<<2] <<EOF\nls");
});

test("an opener inside a command substitution still opens, also within double quotes", () => {
  const command = "git commit -m \"$(cat <<'EOF'\nmsg $(rm x)\nEOF\n)\"\nls";
  assert.equal(stripHeredocBodies(command), "git commit -m \"$(cat <<'EOF'\n)\"\nls");
  assert.deepEqual(heredocBodies(command), [{ head: "git commit -m \"$(cat <<'EOF'", tag: "EOF", body: "msg $(rm x)", quoted: true }]);
  assert.equal(stripHeredocBodies("echo \"$(case a in a) cat <<EOF ;; esac)\"\nb\nEOF\nls"), "echo \"$(case a in a) cat <<EOF ;; esac)\"\nls");
});

// bash reads a backtick span whole, quotes and all, up to the next backtick,
// and only then parses it, so a heredoc inside never reaches past it.
test("a heredoc inside backticks never takes the lines after the closing backtick", () => {
  const command = "x=`: <<EOF\nb\n`; rm -rf x\nEOF";
  assert.equal(stripHeredocBodies(command), command);
  // The span ends at `a`` despite the open `"`; the `#` after it comments out the `<<EOF`.
  const quoted = "echo `echo \"a`; rm -rf x # \"` <<EOF\nb\nEOF\nls";
  assert.equal(stripHeredocBodies(quoted), quoted);
});

// The delimiter is the whole shell word, quote-removed, as bash reads it.
test("a partly quoted or spaced delimiter ends the body at the word bash reads", () => {
  assert.equal(stripHeredocBodies("cat <<'EO'F\nb\nEOF\nrm -rf x"), "cat <<'EO'F\nrm -rf x");
  assert.equal(stripHeredocBodies('cat <<E"OF"\nb\nEOF\nrm -rf x'), 'cat <<E"OF"\nrm -rf x');
  assert.equal(stripHeredocBodies("cat <<E\\OF\nb\nEOF\nrm -rf x"), "cat <<E\\OF\nrm -rf x");
  assert.equal(stripHeredocBodies("cat <<'EOF bar'\nEOF\nb\nEOF bar\nls"), "cat <<'EOF bar'\nls");
  assert.equal(stripHeredocBodies("cat <<END-OF\nEND\nb\nEND-OF\nls"), "cat <<END-OF\nls");
  assert.deepEqual(
    heredocBodies("cat <<'EO'F <<E\\OF <<END-OF\na\nEOF\nb\nEOF\nc\nEND-OF").map((h) => [h.tag, h.quoted, h.body]),
    [["EOF", true, "a"], ["EOF", true, "b"], ["END-OF", false, "c"]],
  );
});

// bash reads a body only once the command line has ended.
test("a quote or a continuation open at the end of the opener's line defers the body", () => {
  assert.equal(stripHeredocBodies('cat <<EOF "a\nb"\nbody\nEOF\nls'), 'cat <<EOF "a\nb"\nls');
  assert.equal(stripHeredocBodies("cat <<EOF \\\n&& rm -rf x\nbody\nEOF\nls"), "cat <<EOF \\\n&& rm -rf x\nls");
  assert.equal(stripHeredocBodies("x=$(cat <<EOF\nbody\nEOF\n)\nls"), "x=$(cat <<EOF\n)\nls");
});

// Property, with bash as the oracle: no line the strip drops is one bash runs.
// Lines are built from shapes that open, quote or close heredocs; each marker
// line prints `@@L<n>@@`, and a marker bash printed at the start of a line of
// output must sit on a line stripHeredocBodies kept.
const SHAPES = [
  (n) => `echo @@L${n}@@`,
  () => ": <<EOF",
  () => ": <<\\EOF",
  () => ": <<-\\EOF",
  () => ": <<'EOF'",
  () => ': <<E"OF"',
  () => "x=$(: <<EOF",
  () => ")",
  () => "EOF",
  () => "\tEOF",
  () => "cat <<<EOF >/dev/null",
  () => "printf 'a<<\\n' >/dev/null",
  () => 'echo "x<<\\tb" >/dev/null',
  () => "printf 'a<<EOF' >/dev/null",
  () => ": $((1<<EOF))",
  () => "true # <<EOF",
  () => "true # <<\\EOF",
  () => "echo 'open <<EOF",
  () => "echo \"open <<\\EOF",
  () => "close'",
  () => 'close"',
  () => ": <<EOF \\",
  () => ": $'a\\'<<EOF'",
  () => "x=`: <<EOF",
  () => "`",
  () => ": $[1<<EOF]",
  () => "a[1<<EOF]=3",
  () => "a[1<<2]=3",
  () => "declare a[1<<EOF]=3 2>/dev/null",
];
const SUFFIXES = [(n) => ` ; echo @@L${n}@@`, () => " <<EOF", () => " <<\\EOF", () => " 'q<<EOF'", () => " # <<EOF", () => ""];

test("no line the strip drops is one bash runs (random commands, bash as oracle)", { skip: spawnSync("bash", ["-c", "true"]).status !== 0 && "no bash" }, () => {
  let seed = 2587;
  const rand = (k) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % k;
  };
  let ran = 0;
  let dropped = 0;
  for (let c = 0; c < 600; c++) {
    const lines = [];
    const count = 2 + rand(8);
    for (let n = 0; n < count; n++) {
      // A marker line one time in three, so most commands run some.
      const shape = rand(3) === 0 ? SHAPES[0] : SHAPES[1 + rand(SHAPES.length - 1)];
      lines.push(shape(n) + SUFFIXES[rand(SUFFIXES.length)](n));
    }
    const command = lines.join("\n");
    const stripped = stripHeredocBodies(command).split("\n");
    if (stripped.length < lines.length) dropped++;
    const kept = new Set(stripped);
    const run = spawnSync("bash", ["-c", command], { encoding: "utf8", timeout: 5000, cwd: tmpdir() });
    for (const out of run.stdout.split("\n")) {
      const m = /^@@L(\d+)@@/.exec(out);
      if (!m) continue;
      ran++;
      const source = lines[Number(m[1])];
      assert.ok(kept.has(source), `bash ran line ${m[1]} but the strip dropped it:\n${command}`);
    }
  }
  assert.ok(ran > 300, `bash ran only ${ran} marker lines; the property was barely tested`);
  assert.ok(dropped > 100, `the strip dropped lines in only ${dropped} commands; the property was barely tested`);
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
