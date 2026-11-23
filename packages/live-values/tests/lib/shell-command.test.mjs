// Tests for the heredoc readers in the shared shell-command lib. Gates call
// stripHeredocBodies and heredocBodies on every shell command they judge, so a
// crafted command must not make them slow or make them throw: a gate that
// stalls or crashes is a gate that is skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as shell from "../../engine/lib/shell-command.mjs";

const { heredocBodies, shellWords, splitSegmentsDetailed, stripHeredocBodies } = shell;

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
const growth = (fn, make = openers) => {
  const small = make(8_000);
  const large = make(128_000);
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

test("joinContinuations grows linearly with the text", () => {
  for (const unit of ['x "$(y)" a\\\nb ', "a", "$(", "<\\\n", "x[1] "]) {
    const ratio = growth((s) => shell.joinContinuations(s), (n) => `${unit.repeat(n / 4)}\\\n`);
    assert.ok(ratio < 48, `${JSON.stringify(unit)}: 16x the text took ${ratio.toFixed(1)}x the time`);
  }
});

// `>|` writes a file even under noclobber: one redirection operator, not `>` and a pipe.
test("splitSegmentsDetailed keeps >| inside its segment; a real pipe still splits", () => {
  assert.deepEqual(
    splitSegmentsDetailed("cat >| m.txt <<EOF && git commit -F m.txt").map((s) => s.text.trim()),
    ["cat >| m.txt <<EOF", "git commit -F m.txt"],
  );
  assert.deepEqual(
    splitSegmentsDetailed("echo x >|m.txt").map((s) => s.text),
    ["echo x >|m.txt"],
  );
  assert.deepEqual(
    splitSegmentsDetailed("printf x | tee m.txt").map((s) => [s.sep, s.text.trim()]),
    [["", "printf x"], ["|", "tee m.txt"]],
  );
  // An escaped `>` is a character, so the `|` after it is a pipe.
  assert.deepEqual(splitSegmentsDetailed("echo \\> | cat").length, 2);
});

// Inside single quotes a backslash is a character: it escapes nothing, `'a\'` is closed.
test("splitSegments reads a backslash in single quotes as a character", () => {
  assert.deepEqual(shell.splitSegments("echo 'a\\' ; echo 'b' > x"), ["echo 'a\\' ", " echo 'b' > x"]);
  // In double quotes it still escapes the quote.
  assert.deepEqual(shell.splitSegments('echo "a\\" ; b" ; ls'), ['echo "a\\" ; b" ', " ls"]);
});

// `$'…'` is ANSI-C quoting: a backslash escapes the next character, so `$'\''` is one quote
// character and the `;` after it splits. `$$` is the pid, so in `$$'x'` the quote is a plain
// single quote and a backslash in it is a character; `$$$'x'` is the pid and then `$'x'`, and an
// escaped `\$` opens nothing. Each split is the one bash runs.
test("splitSegments reads `$'…'` with its escapes, and `$$'…'` as the pid and a plain quote", () => {
  for (const [run, segments] of [
    [String.raw`echo $'\'';git commit --no-verify -m x;echo \'`, [String.raw`echo $'\''`, "git commit --no-verify -m x", String.raw`echo \'`]],
    [String.raw`echo $'\\';git commit --no-verify -m x;echo x`, [String.raw`echo $'\\'`, "git commit --no-verify -m x", "echo x"]],
    [String.raw`echo $'a\'b ';git commit --no-verify -m x;echo 'c'`, [String.raw`echo $'a\'b '`, "git commit --no-verify -m x", "echo 'c'"]],
    [String.raw`echo $$$'a\'';git commit --no-verify -m x;echo \'`, [String.raw`echo $$$'a\''`, "git commit --no-verify -m x", String.raw`echo \'`]],
    [String.raw`echo $$'a\';echo b`, [String.raw`echo $$'a\'`, "echo b"]],
    [String.raw`echo \$'a\';echo b`, [String.raw`echo \$'a\'`, "echo b"]],
  ]) assert.deepEqual(shell.splitSegments(run), segments, run);
});

// Bash reads `$'` literally in a quote glued to a word (it opens there, though this
// splitter's quote gate does not), in a `#` comment and in a heredoc body. There a quote
// closes at the next quote character, so the `;` or newline after it splits. Each split
// is the one bash runs.
test("splitSegments reads `$'` literally in a glued quote, a comment and a heredoc body", () => {
  for (const [run, segments] of [
    [String.raw`echo a"$'\'";git commit --no-verify -m x;echo ''`, [String.raw`echo a"$'\'"`, "git commit --no-verify -m x", "echo ''"]],
    [String.raw`echo a'x$'\';git commit --no-verify -m x;echo ''`, [String.raw`echo a'x$'\'`, "git commit --no-verify -m x", "echo ''"]],
    ["echo hi # c $'\\'\ngit commit --no-verify -m x\necho ''", ["echo hi # c $'\\'", "git commit --no-verify -m x", "echo ''"]],
    ["cat <<EOF\necho $'\\'\nEOF\ngit commit --no-verify -m x\necho ''", ["cat <<EOF", "echo $'\\'", "EOF", "git commit --no-verify -m x", "echo ''"]],
  ]) assert.deepEqual(shell.splitSegments(run), segments, run);
});

// A `#` opens a comment only where bash opens one: at the start of a word, in a command
// context. After an escaped blank (`a\ #x` is one word), inside `${…}` or `$((…))`, in
// quotes, or after a removed backslash-newline it is a character, so `$'` there is ANSI-C
// quoting and the `;` after `$'\''` splits. In backticks and in `$(…)` a comment ends where
// the substitution's text or line ends. Bash is the oracle: with `echo RAN` in place of the
// commit, each command prints RAN.
test("splitSegments opens a comment only at a word start in a command context", { skip: spawnSync("bash", ["-c", "true"]).status !== 0 && "no bash" }, () => {
  const commit = "git commit --no-verify -m x";
  // Each head ends in a quote bash closes; the commit runs after it.
  const row = (head) => [`${head};${commit};echo ''`, [head, commit, "echo ''"]];
  for (const [run, segments] of [
    row("echo a\\ #x $'\\''"),
    row("echo ${x// #/y} $'\\''"),
    row("echo ${x:-a #x} $'\\''"),
    // Not evaluated after `true ||`, so bash's arithmetic error never stops the line.
    [`true || echo $(( 1 #2 )) $'\\'';${commit};echo ''`, ["true ", " echo $(( 1 #2 )) $'\\''", commit, "echo ''"]],
    row("echo \"a #x\" $'\\''"),
    row("echo a\\\n#x $'\\''"),
    row("echo `true #x $'\\'`"),
    [`echo $(true #x $'\\'\n);${commit};echo ''`, ["echo $(true #x $'\\'", ")", commit, "echo ''"]],
  ]) {
    assert.deepEqual(shell.splitSegments(run), segments, run);
    const ran = spawnSync("bash", ["-c", run.replace(commit, "echo RAN")], { encoding: "utf8", timeout: 5000, cwd: tmpdir() });
    assert.match(ran.stdout, /^RAN$/m, `bash runs the hidden command: ${run}`);
  }
});

// A gate that reads redirections needs to know a quoted `> x` is an argument.
test("shellWordsDetailed marks a word whose first character is bare", () => {
  assert.equal(typeof shell.shellWordsDetailed, "function");
  const bare = (s) => shell.shellWordsDetailed(s).map(({ word, bareStart }) => ({ word, bareStart }));
  assert.deepEqual(bare("echo '> note' >out \\>x \"$f\">y >\"$g\""), [
    { word: "echo", bareStart: true },
    { word: "> note", bareStart: false },
    { word: ">out", bareStart: true },
    { word: ">x", bareStart: false },
    { word: "$f>y", bareStart: false },
    { word: ">$g", bareStart: true },
  ]);
  assert.deepEqual(shellWords("echo '> note' >out"), ["echo", "> note", ">out"]);
});

// Bash removes a backslash and the newline after it before it reads the words, outside single quotes.
test("shellWordsDetailed joins a line continuation as bash does", () => {
  const w = (s) => shell.shellWordsDetailed(s).map(({ word, bareStart, expands }) => [word, bareStart, expands]);
  const NL = "\\\n";
  const cases = [
    [`al${NL}pha`, [["alpha", true, false]]],
    [`"al${NL}pha"`, [["alpha", false, false]]],
    [`al${NL}${NL}pha`, [["alpha", true, false]]],
    [`alpha ${NL}beta`, [["alpha", true, false], ["beta", true, false]]],
    [`alpha${NL}`, [["alpha", true, false]]],
    [`${NL}`, []],
    [`${NL}~`, [["~", true, true]]],
    [`${NL}>out`, [[">out", true, false]]],
    [`$${NL}HOME`, [["$HOME", true, true]]],
    [`"$${NL}HOME"`, [["$HOME", false, true]]],
    [`<${NL}(date)`, [["<(date)", true, true]]],
    [`$${NL}'x'`, [["$x", true, true]]],
    [`'al${NL}pha'`, [[`al${NL}pha`, false, false]]],
    [`$'al${NL}pha'`, [[`$al${NL}pha`, true, true]]],
    [`al\\\\\npha`, [["al\\", true, false], ["pha", true, false]]],
    [`"al\\\\\npha"`, [["al\\\npha", false, false]]],
  ];
  for (const [input, words] of cases) assert.deepEqual(w(input), words, JSON.stringify(input));
});

test("shellWordsDetailed keeps a backslash that ends a comment: that line continues nothing", () => {
  assert.deepEqual(shellWords("alpha # note\\\nbeta"), ["alpha", "#", "note\nbeta"]);
});

// The cases below are read as text. `J` is a backslash followed by a newline.
const J = "\\\n";
const wrongWords = (cases) => cases.filter(([input, words]) => JSON.stringify(shellWords(input)) !== JSON.stringify(words)).map(([input]) => [input, shellWords(input)]);

// The second `$` of `$$` names the pid parameter, so the quote after it is a plain one.
test("shellWordsDetailed: a quote after $$ opens no $'…' string and hides no word after it, joined or glued", () => {
  const cases = [
    [`cmd $$${J}'\\' --flag`, ["cmd", "$$\\", "--flag"]],
    ["cmd $$'\\' --flag", ["cmd", "$$\\", "--flag"]],
    [`cmd $${J}$'\\' --flag`, ["cmd", "$$\\", "--flag"]],
    [`cmd $${J}$${J}'\\' --flag`, ["cmd", "$$\\", "--flag"]],
    ["cmd $$$$'\\' --flag", ["cmd", "$$$$\\", "--flag"]],
    [`cmd $$'\\' -${J}X`, ["cmd", "$$\\", "-X"]],
    // A third `$` opens one again.
    ["cmd $$$'a\\'b' --flag", ["cmd", "$$$a\\'b", "--flag"]],
  ];
  assert.deepEqual(wrongWords(cases), []);
});

test("shellWordsDetailed keeps a pair that bash keeps inside a substitution", () => {
  const cases = [
    [`"$(printf %s 'a${J}b')"`, [`$(printf %s 'a${J}b')`]],
    [`"$(printf %s $'a${J}b')"`, [`$(printf %s $'a${J}b')`]],
    [`"$(: # note${J}next)"`, [`$(: # note${J}next)`]],
    [`"$(echo "$(printf 'a${J}b')")"`, [`$(echo $(printf`, `a${J}b))`]],
    [`"$( (:); printf 'a${J}b')"`, [`$( (:); printf 'a${J}b')`]],
    [`"$((echo a); printf 'a${J}b')"`, [`$((echo a); printf 'a${J}b')`]],
    [`"\${x:-'a${J}b'}"`, [`\${x:-'a${J}b'}`]],
    [`"$(case a in a) printf 'a${J}b';; esac)"`, [`$(case a in a) printf 'a${J}b';; esac)`]],
    [`"$(case a in (a) :;; esac; printf 'a${J}b')"`, [`$(case a in (a) :;; esac; printf 'a${J}b')`]],
    [`"$(echo case)" 'a${J}b'`, ["$(echo case)", `a${J}b`]],
    // A quoted or escaped `case` is a plain word.
    [`"$(ca''se)" 'a${J}b'`, ["$(ca''se)", `a${J}b`]],
    [`"$(ca\\se)" 'a${J}b'`, ["$(ca\\se)", `a${J}b`]],
    [`"\`printf x\`" '"' 'a${J}b'`, ["`printf x`", '"', `a${J}b`]],
    [`"\`echo "x"\`" 'a${J}b'`, ["`echo x`", `a${J}b`]],
  ];
  assert.deepEqual(wrongWords(cases), []);
});

test("shellWordsDetailed keeps the terminator of a quoted heredoc inside a substitution", () => {
  for (const tag of ["'E'", '\\E', `'E'${J}`]) {
    const [word] = shellWords(`"$(cat <<${tag}\nbody${J}E\nnext --flag\n)"`);
    assert.match(word, /body\\\nE\n/, tag);
    const program = stripHeredocBodies(word.slice(2, -1));
    assert.ok(program.split("\n").includes("next --flag"), `${tag}: ${JSON.stringify(program)}`);
  }
});

test("shellWordsDetailed joins after nested quoting, and a # opens a comment only after bash's blanks and operators", () => {
  const cases = [
    [`cmd "$(printf "fix #57")" -${J}X`, ["cmd", "$(printf fix", "#57)", "-X"]],
    [`cmd "\`printf "fix #57"\`" -${J}X`, ["cmd", "`printf fix", "#57`", "-X"]],
    [`cmd "\${x:-"fix #57"}" -${J}X`, ["cmd", "${x:-fix", "#57}", "-X"]],
    [`cmd "$(case a in a) printf "fix #57";; esac)" -${J}X`, ["cmd", "$(case a in a) printf fix", "#57;; esac)", "-X"]],
    // Part of a word: no comment.
    [`cmd $(:)#x -${J}X`, ["cmd", "$(:)#x", "-X"]],
    [`cmd $(:)${J}#x -${J}X`, ["cmd", "$(:)#x", "-X"]],
    [`cmd $((1+1))#x -${J}X`, ["cmd", "$((1+1))#x", "-X"]],
    [`cmd <(:)#x -${J}X`, ["cmd", "<(:)#x", "-X"]],
    [`cmd @(a)#x -${J}X`, ["cmd", "@(a)#x", "-X"]],
    [`a=(1)#x cmd -${J}X`, ["a=(1)#x", "cmd", "-X"]],
    [`cmd \${x:- #a} -${J}X`, ["cmd", "${x:-", "#a}", "-X"]],
    [`cmd $[ #a] -${J}X`, ["cmd", "$[", "#a]", "-X"]],
    [`cmd a\r#x -${J}X`, ["cmd", "a", "#x", "-X"]],
    [`cmd a\f#x -${J}X`, ["cmd", "a", "#x", "-X"]],
    [`cmd a #x -${J}X`, ["cmd", "a", "#x", "-X"]],
    // After a blank or an operator: a comment, and its last backslash continues nothing.
    [`cmd\t#c${J}next`, ["cmd", "#c\nnext"]],
    [`cmd;#c${J}next`, ["cmd;#c\nnext"]],
    [`cmd >#c${J}next`, ["cmd", ">#c\nnext"]],
    [`cmd <#c${J}next`, ["cmd", "<#c\nnext"]],
    [`(:)#c${J}next`, ["(:)#c\nnext"]],
    [`((1))#c${J}next`, ["((1))#c\nnext"]],
  ];
  assert.deepEqual(wrongWords(cases), []);
});

// A flag split by `J` after a substitution is joined only when the scanner has left the
// substitution where bash did. Each input below put it in the wrong place: a `case` word that
// is no keyword, a redirection's word read as one, a heredoc drained in the wrong context.
const stuckProbes = [
  ["a `case` in a pattern list", `git commit "$(case q in q|case) printf q;; esac)" '"' -${J}-no-verify`, "--no-verify"],
  ["`in case` in a command's arguments", `"$(case q in q) printf %s in case;; esac)" '"' -${J}X`, "-X"],
  ["`for v in case`", `"$(case q in q) for v in case; do :; done;; esac)" '"' -${J}X`, "-X"],
  ["a word after `<`", `"$(< case printf q)" '"' -${J}X`, "-X"],
  ["`case case in case`", `"$(case case in case) printf q;; esac)" '"' -${J}X`, "-X"],
  ["a word after `<<<`", `"$(<<<case cat)" '"' -${J}X`, "-X"],
  ["a heredoc opened outside a substitution that holds a newline", `git commit <<'E' "$(printf a\n)" -${J}-no-verify\nb\nE\n`, "--no-verify"],
];
for (const [name, input, flag] of stuckProbes) {
  test(`shellWords joins the flag after ${name}`, () => {
    const words = shellWords(input);
    assert.ok(words.includes(flag), JSON.stringify(words));
    assert.ok(!words.some((w) => w.includes("-\n")), JSON.stringify(words));
  });
}

test("shellWords follows the case grammar: a keyword stands only in command position", () => {
  const cases = [
    // The `)` after a pattern ends the pattern list, however the pattern is written.
    [`"$(case q in (q) :;; esac)" '"' -${J}X`],
    [`"$(case q in q|r) :;& r) :;;& esac)" '"' -${J}X`],
    [`"$(case q in esac) :;; esac)" '"' -${J}X`],
    [`"$(case q\nin\nq) :;;\nesac)" '"' -${J}X`],
    [`"$(case q in q) case r in r) :;; esac;; esac)" '"' -${J}X`],
    [`"$(case q in q) :;; esac; case q in q) :;; esac)" '"' -${J}X`],
    // `esac` ends a body without `;;`, and a pattern after `;;` is no command.
    [`"$(case q in q) :; esac)" '"' -${J}X`],
    [`"$(case q in q) :;; case) :;; esac)" '"' -${J}X`],
    // A redirection's word, and a word of a command, is no keyword.
    [`"$(printf q >case; :)" '"' -${J}X`],
    [`"$(printf q 2>&1 case)" '"' -${J}X`],
    [`"$(printf q >&2 case)" '"' -${J}X`],
    [`"$(printf q >& case)" '"' -${J}X`],
    [`"$(cat <<<case; :)" '"' -${J}X`],
    // `case` after a keyword, an assignment or a separator is one.
    [`"$(if :; then case q in q) :;; esac; fi)" '"' -${J}X`],
    [`"$(v=1 case q in q) :;; esac)" '"' -${J}X`],
  ];
  for (const [input] of cases) {
    const words = shellWords(input);
    assert.equal(words.at(-1), "-X", JSON.stringify([input, words]));
  }
});

test("joinContinuations hands a heredoc opened in a substitution to the line that ends the command", () => {
  // Bash reads the body of `$(cat <<E)` from the lines after it, and a newline inside the
  // substitution before that belongs to the substitution.
  assert.equal(shell.joinContinuations(`x=$(cat <<E)\nfoo${J}E\nE\necho 'a${J}b'`), `x=$(cat <<E)\nfooE\nE\necho 'a${J}b'`);
  assert.equal(shell.joinContinuations(`x=$(cat <<'E')\nfoo${J}E\nE\necho c${J}d`), `x=$(cat <<'E')\nfoo${J}E\nE\necho cd`);
  assert.equal(shell.joinContinuations(`cat <<'E' "$(:\n)" c${J}d\nfoo${J}E\nE\necho c${J}d`), `cat <<'E' "$(:\n)" cd\nfoo${J}E\nE\necho cd`);
});

test("shellWordsDetailed gives pattern, operatorAt and procSubAt of the joined word", () => {
  // [input, word, bareStart, expands, pattern, operatorAt, procSubAt]
  const cases = [
    [`a${J}b${J}>f`, "ab>f", true, false, false, [2], []],
    [`${J}>out`, ">out", true, false, false, [0], []],
    [`2>${J}&1`, "2>&1", true, false, false, [1], []],
    [`x>${J}>g`, "x>>g", true, false, false, [1, 2], []],
    [`x<${J}(a)`, "x<(a)", true, true, false, [], [1]],
    [`a${J}b>${J}(c)`, "ab>(c)", true, true, false, [], [2]],
    [`{a${J},b}`, "{a,b}", true, true, true, [], []],
    [`{a.${J}.c}`, "{a..c}", true, true, true, [], []],
    [`@${J}(a)`, "@(a)", true, true, true, [], []],
    [`$$${J}*`, "$$*", true, true, true, [], []],
    [`$${J}?`, "$?", true, true, false, [], []],
    [`$${J}{a,b}`, "${a,b}", true, true, false, [], []],
    [`$$${J}'\\'>g`, "$$\\>g", true, true, false, [3], []],
    ["$$'*'>g", "$$*>g", true, true, false, [3], []],
    [`'a${J}b'>f`, `a${J}b>f`, false, false, false, [4], []],
    [`'a${J}b'<(c)`, `a${J}b<(c)`, false, true, false, [], [4]],
    [`"$(printf 'a${J}b')">f`, `$(printf 'a${J}b')>f`, false, true, false, [16], []],
  ];
  for (const [input, word, bareStart, expands, pattern, operatorAt, procSubAt] of cases) {
    assert.deepEqual(shell.shellWordsDetailed(input), [{ word, bareStart, expands, pattern, operatorAt, procSubAt }], JSON.stringify(input));
  }
});

test("joinContinuations removes a pair where bash does and keeps it where bash does", () => {
  const cases = [
    [`cat $${J}(x)`, "cat $(x)"],
    [`echo "$(echo a${J}b)"`, 'echo "$(echo ab)"'],
    [`echo $${J}'a\\'b' c${J}d`, "echo $'a\\'b' cd"],
    // Inside double quotes `$'` opens nothing: the pair is removed and the quote is a character.
    [`echo "$'a${J}b'"`, `echo "$'ab'"`],
    ["echo a\\\\\nb" + J, "echo a\\\\\nb"],
    [`echo a ${J}#c${J}next`, `echo a #c${J}next`],
    [`echo a${J}#b${J}c`, "echo a#bc"],
    // An unquoted body is joined before its terminator is matched; a quoted one is kept.
    [`cat <<E\nfoo${J}E\nbar\nE\necho a${J}b`, "cat <<E\nfooE\nbar\nE\necho ab"],
    [`cat <<E${J}OF\nx\nEOF\necho 'a${J}b'`, `cat <<EOF\nx\nEOF\necho 'a${J}b'`],
    [`cat <${J}<'E'\na${J}b\nE\necho c${J}d`, `cat <<'E'\na${J}b\nE\necho cd`],
    [`cat <<${J}-E\n\tE\necho 'a${J}b'`, `cat <<-E\n\tE\necho 'a${J}b'`],
    [`cat <<'E F'\na${J}b\nE F\necho c${J}d`, `cat <<'E F'\na${J}b\nE F\necho cd`],
    // No heredoc: a herestring, a shift, a subscript, an expansion.
    [`cat <<${J}<x\necho 'a${J}b'`, `cat <<<x\necho 'a${J}b'`],
    [`echo $${J}((1<<2))\necho 'a${J}b'`, `echo $((1<<2))\necho 'a${J}b'`],
    [`echo $[1<<2]\necho 'a${J}b'`, `echo $[1<<2]\necho 'a${J}b'`],
    [`echo \${x:-<<E}\necho 'a${J}b'`, `echo \${x:-<<E}\necho 'a${J}b'`],
    [`a[1<<2]=3\necho 'a${J}b'`, `a[1<<2]=3\necho 'a${J}b'`],
    [`x=1 a[1<<2]=3\necho 'a${J}b'`, `x=1 a[1<<2]=3\necho 'a${J}b'`],
    // Inside backticks bash removes every pair, then reads the program; an escaped backslash stays.
    [`echo \`echo 'a${J}b'\``, "echo `echo 'ab'`"],
    [`echo \`echo a # c${J}echo b\``, "echo `echo a # cecho b`"],
    [`echo \`echo 'a\\${J}b'\``, `echo \`echo 'a\\${J}b'\``],
    [`echo \`true\`'a${J}b'`, `echo \`true\`'a${J}b'`],
  ];
  assert.equal(typeof shell.joinContinuations, "function");
  for (const [input, joined] of cases) {
    assert.equal(shell.joinContinuations(input), joined, JSON.stringify(input));
    assert.equal(shell.joinContinuations(joined), joined, `again: ${JSON.stringify(joined)}`);
  }
});

// A gate that reads a word's text needs to know when the shell would expand it, and where a bare
// `<` or `>` inside the word starts a redirection.
test("shellWordsDetailed marks a word that expands and the bare < and > inside it", () => {
  const w = (s) => shell.shellWordsDetailed(s).map(({ word, expands, operatorAt }) => ({ word, expands, operatorAt }));
  assert.deepEqual(w("echo \"$B\" '$B' \\$B $'x' `d` \"a $\" \"a \\$b\" $"), [
    { word: "echo", expands: false, operatorAt: [] },
    { word: "$B", expands: true, operatorAt: [] },
    { word: "$B", expands: false, operatorAt: [] },
    { word: "$B", expands: false, operatorAt: [] },
    { word: "$x", expands: true, operatorAt: [] },
    { word: "`d`", expands: true, operatorAt: [] },
    { word: "a $", expands: false, operatorAt: [] },
    { word: "a $b", expands: false, operatorAt: [] },
    { word: "$", expands: false, operatorAt: [] },
  ]);
  assert.deepEqual(w("echo \"a b\">f x>>g 2>&1 '>q' \"c>d\" \\<e"), [
    { word: "echo", expands: false, operatorAt: [] },
    { word: "a b>f", expands: false, operatorAt: [3] },
    { word: "x>>g", expands: false, operatorAt: [1, 2] },
    { word: "2>&1", expands: false, operatorAt: [1] },
    { word: ">q", expands: false, operatorAt: [] },
    { word: "c>d", expands: false, operatorAt: [] },
    { word: "<e", expands: false, operatorAt: [] },
  ]);
  // shellWords is unchanged by the new fields.
  assert.deepEqual(shellWords("echo \"a b\">f"), ["echo", "a b>f"]);
});

test("shellWordsDetailed flags brace, glob and tilde expansion; pattern marks the ones that make several words or read the disk", () => {
  const w = (s) => shell.shellWordsDetailed(s).map(({ word, expands, pattern }) => ({ word, expands, pattern }));
  const flags = (s) => w(s).map(({ expands, pattern }) => [expands, pattern]);
  // Brace expansion: bash passes `-m 'Co-Authored-By: Claude' -m 'Co-Authored-By: Cl'`.
  assert.deepEqual(w("\"Co-Authored-By: Cl\"{aude,}"), [{ word: "Co-Authored-By: Cl{aude,}", expands: true, pattern: true }]);
  assert.deepEqual(flags("x{a,b} {a..c} {} {a} '{a,b}' \\{a,b} {a\",\"b} \"{a,b}\""), [
    [true, true], [true, true], [false, false], [false, false], [false, false], [false, false], [false, false], [false, false],
  ]);
  // Globs read the disk: the word the shell passes is not the literal.
  assert.deepEqual(flags("*.md b.m? [ab].md '*.md' \"*\" \\* [ x] a]"), [
    [true, true], [true, true], [true, true], [false, false], [false, false], [false, false], [false, false], [false, false], [false, false],
  ]);
  // A parameter is an expansion, not a pattern: `$?` and `$*` are no globs, `${A}` and `$[1]` no braces.
  assert.deepEqual(flags("$? $* ${A} ${a,b} $[1]"), [[true, false], [true, false], [true, false], [true, false], [true, false]]);
  // A leading tilde, or one after a bare = or :, is the home directory.
  assert.deepEqual(flags("~/f ~ a=~/x p:~/y '~' \"~/f\" x~ \\~"), [
    [true, false], [true, false], [true, false], [true, false], [false, false], [false, false], [false, false], [false, false],
  ]);
});

test("shellWordsDetailed: only a $ that starts an expansion flags the word, and a $'…' string holds no operator", () => {
  const w = (s) => shell.shellWordsDetailed(s).map(({ expands, operatorAt }) => [expands, operatorAt]);
  // `$.`, `$%`, `$,` and `$/` stay literal in bash; `$-` (the option flags), `$?`, `$$`, `$1` and `${A}` expand.
  assert.deepEqual(w("$. $% $, $/ \"a $.\" $- $? $$ $1 ${A} \"$-\""), [
    [false, []], [false, []], [false, []], [false, []], [false, []],
    [true, []], [true, []], [true, []], [true, []], [true, []], [true, []],
  ]);
  // The `>` is inside the ANSI-C string, after an escaped quote: no redirection starts there.
  assert.deepEqual(w("$'\\'>f' $'a'>g"), [[true, []], [true, [2]]]);
});

test("shellWordsDetailed: bare < and the forms the review listed", () => {
  const w = (s) => shell.shellWordsDetailed(s).map(({ word, expands, operatorAt }) => ({ word, expands, operatorAt }));
  assert.deepEqual(w("<in <<EOF >|f \"`d`\" \"${A}\" \"$(x)\" x\\`y\\`"), [
    { word: "<in", expands: false, operatorAt: [0] },
    { word: "<<EOF", expands: false, operatorAt: [0, 1] },
    { word: ">|f", expands: false, operatorAt: [0] },
    { word: "`d`", expands: true, operatorAt: [] },
    { word: "${A}", expands: true, operatorAt: [] },
    { word: "$(x)", expands: true, operatorAt: [] },
    { word: "x`y`", expands: false, operatorAt: [] },
  ]);
});

test("shellWordsDetailed: a process substitution expands, is no redirection, and procSubAt marks it", () => {
  const w = (s) => shell.shellWordsDetailed(s).map(({ word, expands, operatorAt, procSubAt }) => ({ word, expands, operatorAt, procSubAt }));
  // Bash passes `/dev/fd/63` and tee writes the file: a gate reading `>(tee` as a redirect misses it.
  assert.deepEqual(w("echo x >(tee f) <(cat g) a>(b)"), [
    { word: "echo", expands: false, operatorAt: [], procSubAt: [] },
    { word: "x", expands: false, operatorAt: [], procSubAt: [] },
    { word: ">(tee", expands: true, operatorAt: [], procSubAt: [0] },
    { word: "f)", expands: false, operatorAt: [], procSubAt: [] },
    { word: "<(cat", expands: true, operatorAt: [], procSubAt: [0] },
    { word: "g)", expands: false, operatorAt: [], procSubAt: [] },
    { word: "a>(b)", expands: true, operatorAt: [], procSubAt: [1] },
  ]);
  // A redirect into a process substitution keeps its own operator.
  assert.deepEqual(w("> >(cat) --f=<(x)"), [
    { word: ">", expands: false, operatorAt: [0], procSubAt: [] },
    { word: ">(cat)", expands: true, operatorAt: [], procSubAt: [0] },
    { word: "--f=<(x)", expands: true, operatorAt: [], procSubAt: [4] },
  ]);
  // Quoted or escaped, it is text.
  assert.deepEqual(w("'>(x)' \">(x)\" \\>(x) \"$a>(\"").map((x) => [x.expands, x.procSubAt]), [
    [false, []], [false, []], [false, []], [true, []],
  ]);
});

test("shellWordsDetailed: an extglob is a pattern, and so is a glob after $$ or another special parameter", () => {
  const flags = (s) => shell.shellWordsDetailed(s).map(({ expands, pattern }) => [expands, pattern]);
  assert.deepEqual(flags("@(a|b) !(a) +(a) ?(a) *(a)"), [[true, true], [true, true], [true, true], [true, true], [true, true]]);
  assert.deepEqual(flags("a@b a+b !x '@(a)' \\@(a) $@ $!"), [
    [false, false], [false, false], [false, false], [false, false], [false, false], [true, false], [true, false],
  ]);
  // `$$*` is the pid and a glob, bash matches `<pid>a`; `$?*`, `$-?`, `$1?` and `$$@(a|b)` the same.
  assert.deepEqual(flags("$$* $$? $$[ab] $?* $-? $1? $$$$* $$@(a|b)"), [
    [true, true], [true, true], [true, true], [true, true], [true, true], [true, true], [true, true], [true, true],
  ]);
  // `$$$*` is the pid and `$*`; bash never brace-expands a `${`, so `$${x,y}` passes `<pid>{x,y}`.
  assert.deepEqual(flags("$$ $? $* ${A} $@( $$$* $?( $${x,y}"), [
    [true, false], [true, false], [true, false], [true, false], [true, false], [true, false], [true, false], [true, false],
  ]);
});
