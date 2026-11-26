// Shared machinery for the scripts that read facts out of a repo's prose
// and run a command per fact: a proof reader (one-off claims with a
// `<!-- proof: … -->`) and live-values.mjs (named values with
// `<!-- live:NAME -->`). There is one scope, one runner, one local gate and
// one notion of "inside a generated block", so the two readers cannot
// disagree about which files are docs or which lines are generated.
//
//   collectFiles(root)             the prose in scope (INDEX.md never is)
//   liveScope(root)                collectFiles plus any repo's agent-facing docs
//   autogenMask(lines)             true for each line inside an AUTO-GEN block
//   checkLocal(run, root)          the proof reader's --local gate (every segment, read-only tools)
//   checkQuerySegments(run, tools) every command in a pipeline/list allowlisted
//   runCommand(run, opts)          bash -c in root, with a timeout
//
// autogenMask is anchored: a marker is a WHOLE line, `<!-- AUTO-GEN:start NAME -->`
// or `<!-- AUTO-GEN:end NAME -->`, and an end closes only the block of the same
// NAME. The loose prefix regex it replaces treated a table cell that QUOTES both
// markers as the block's end, so everything after it read as hand-written, and
// a claim placed there reported `ok` when it should be MISPLACED.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { commandStart, commandWord, shellWords, shellWordsDetailed, splitSegments, splitSegmentsDetailed } from "./shell-command.mjs";

// live-values' scope, portable to any repo it is copied into:
// collectFiles plus the agent-facing docs of a project repo - root CLAUDE.md,
// AGENTS.md and README.md, docs/**/*.md at any depth, and skills/*/SKILL.md or
// .claude/skills/*/SKILL.md - never INDEX.md, and in a git checkout only
// TRACKED files, so the hook judges exactly what CI will. Untracked scratch
// docs are not the repo's prose, and git lists a symlink as a link, so a
// skills symlink into a dependency directory is never followed. Outside a git
// checkout it is collectFiles alone.
const PROJECT_DOC_RE = /^(?:(?:CLAUDE|AGENTS|README)\.md|docs\/.+\.md|(?:\.claude\/)?skills\/[^/]+\/SKILL\.md)$/;
export const liveScope = (root) => {
  const base = collectFiles(root);
  let tracked;
  try {
    tracked = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).split("\0");
  } catch {
    return base;
  }
  const inBase = new Set(base.map((abs) => relative(root, abs)));
  const out = [];
  for (const p of tracked) {
    if (!p || /(^|\/)INDEX\.md$/.test(p) || !(inBase.has(p) || PROJECT_DOC_RE.test(p))) continue;
    const abs = join(root, p);
    if (existsSync(abs) && !lstatSync(abs).isSymbolicLink()) out.push(abs);
  }
  return out.sort();
};

// The local lane of a proof-annotation reader: tools that need no network, auth or machine path.
export const LOCAL_TOOLS = new Set(["ls", "test", "grep", "node", "jq", "git", "cat", "wc"]);

// Files in scope: the always-read entry docs plus the docs directory, the seats
// directory and skills that carry factual claims. INDEX.md is generated, so it
// is never in scope. AGENTS.md and CLAUDE.md are both listed; a repo keeps
// whichever entry doc it uses (the other name simply matches nothing). The four
// *-ORGANIZATION.md names come from the setup this engine was extracted from;
// a repo without them loses nothing. seats/ holds one standing brief per seat,
// written to be read before the work and carrying the same kind of claim (a
// lane's floor, a runner path); a repo without it sweeps exactly what it did
// before.
export const collectFiles = (root) => {
  const files = [];
  for (const name of ["AGENTS.md", "CLAUDE.md", "MCP-ORGANIZATION.md", "HOOKS-ORGANIZATION.md", "SKILLS-ORGANIZATION.md", "SCRIPTS-ORGANIZATION.md"]) {
    if (existsSync(join(root, name))) files.push(join(root, name));
  }
  const docs = join(root, "docs");
  if (existsSync(docs)) {
    for (const e of readdirSync(docs, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".md")) files.push(join(docs, e.name));
    }
  }
  const seats = join(root, "seats");
  if (existsSync(seats)) {
    for (const e of readdirSync(seats, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".md")) files.push(join(seats, e.name));
    }
  }
  const skills = join(root, "skills");
  if (existsSync(skills)) {
    for (const e of readdirSync(skills, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const sk = join(skills, e.name, "SKILL.md");
      if (existsSync(sk)) files.push(sk);
      const refs = join(skills, e.name, "references");
      if (existsSync(refs)) {
        for (const r of readdirSync(refs, { withFileTypes: true })) {
          if (r.isFile() && r.name.endsWith(".md")) files.push(join(refs, r.name));
        }
      }
    }
  }
  return files.sort();
};

const AUTOGEN_START = /^\s*<!--\s*AUTO-GEN:start\s+(\S+)\s*-->\s*$/;
const AUTOGEN_END = /^\s*<!--\s*AUTO-GEN:end\s+(\S+)\s*-->\s*$/;

// One boolean per line: true from a start marker through its matching end
// marker, both inclusive. An end with another NAME, or with no open block, is
// ordinary text. A start with no end runs to the end of the file: an
// unterminated block is still generated output, and reading it as hand-written
// is the failure this exists to prevent.
export const autogenMask = (lines) => {
  const mask = new Array(lines.length).fill(false);
  let open = null;
  lines.forEach((line, i) => {
    if (open === null) {
      const s = line.match(AUTOGEN_START);
      if (s) open = s[1];
    }
    mask[i] = open !== null;
    if (open !== null) {
      const e = line.match(AUTOGEN_END);
      if (e && e[1] === open) open = null;
    }
  });
  return mask;
};

const expandPath = (tok) => (tok.startsWith("~") ? join(homedir(), tok.slice(1)) : tok);

// The proof reader's `--local` gate. EVERY command of the proof (each pipe, `&&`,
// `||`, `;` segment and each `$(…)` or backtick substitution) must be on the
// read-only allowlist below, and every path-like argument must exist. Relative
// path-likes resolve against the repo root, which is also the commands' cwd.
// The gate used to read the FIRST word only, so `jq … | gh api …` and
// `node -e '…'` passed it.
export const LOCAL_READ_TOOLS = new Set([
  "ls", "test", "[", "grep", "jq", "git", "cat", "wc", "head", "tail", "sort", "uniq", "cut", "tr",
  "awk", "sed", "stat", "readlink", "find", "cmp", "diff", "printf", "basename", "dirname", "echo",
  "node", "rg", "exit", "true", "false", ":",
]);
// Why a tool is off the list, printed with each skipped proof.
const NETWORK_TOOLS = new Set(["gh", "gcloud", "gsutil", "bq", "curl", "wget", "ssh", "scp", "rsync", "wrangler", "firebase", "npx", "pnpm", "npm"]);
const CONTAINER_TOOLS = new Set(["podman", "docker"]);
const notLocal = (word) => {
  const why = NETWORK_TOOLS.has(word) ? "network" : CONTAINER_TOOLS.has(word) ? "container" : "not on the read-only list";
  return { ok: false, reason: `tool not local: ${word} (${why})` };
};
// Shell builtins need no binary; every other allowed tool must be on PATH, so
// a runner without one (rg on a bare image) skips the proof instead of failing it.
const BUILTINS = new Set(["test", "[", "echo", "printf", "exit", "true", "false", ":"]);
const onPathMemo = new Map();
const onPath = (word) => {
  if (BUILTINS.has(word)) return true;
  const path = process.env.PATH ?? "";
  const key = `${path}\0${word}`;
  if (!onPathMemo.has(key)) onPathMemo.set(key, path.split(":").some((d) => d && existsSync(join(d, word))));
  return onPathMemo.get(key);
};
const GIT_READ = new Set(["log", "show", "diff", "rev-parse", "ls-files", "grep", "cat-file", "status", "rev-list", "for-each-ref"]);
const NODE_SCRIPT_RE = /^(?:~\/\.[\w-]+\/|\.\/)?scripts\/[\w./-]+\.mjs$/;
const NODE_TEST_FLAG_RE = /^--test-(?:reporter|name-pattern|timeout|concurrency|shard|force-exit)(?:=.*)?$/;
const NODE_TEST_FILE_RE = /^(?:~\/\.[\w-]+\/|\.\/)?(?:scripts|skills|templates)\/[\w./-]+\.mjs$/;
const REDIRECT_WORD_RE = /^(?:\d*>&?\d*|>>?|<)$/;

// Output redirected anywhere but /dev/null (or a descriptor, `2>&1`) writes a file.
// Two readings of the segment, and a write is whatever EITHER sees, so neither one's blind spot
// hides a redirect (the check fails closed):
//   1. the shared word scanner, where quotes and backslashes mean what they mean to bash: an
//      escaped quote opens no span, and a quoted `>` is text;
//   2. the older regex that blanks closed quote spans, which still sees the `>` after an
//      unterminated quote or a quote glued to a letter (`echo a'b;echo c'>x`), where the
//      splitter and the scanner read one quote differently, and the `>` in `>'&1'`.
// The price is a false positive on a backslash-escaped `>` (`echo \> x`), never a missed write.
// Harmless targets: /dev/null, and after `>&` a bare descriptor number or `-` (`2>&1`, `>&-`).
// `>&x` is bash's `&>x`: it writes a file named x.
const harmlessTarget = (amp, target) => {
  const t = target.match(/^[^;|&)]*/)[0];
  return amp ? /^(?:\d+|-|\/dev\/null)$/.test(t) : t === "/dev/null";
};
const writesFileByScanner = (segment) => {
  const words = shellWordsDetailed(segment);
  for (let w = 0; w < words.length; w++) {
    const { word, operatorAt } = words[w];
    for (const at of operatorAt) {
      if (word[at] !== ">") continue;
      let rest = word.slice(at + 1).replace(/^>/, "");
      const amp = rest.startsWith("&");
      if (amp) rest = rest.slice(1);
      if (rest === "") rest = words[w + 1]?.word ?? "";
      if (!harmlessTarget(amp, rest)) return true;
    }
  }
  return false;
};
const writesFileByRegex = (segment) => {
  const bare = segment.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, " ");
  for (const m of bare.matchAll(/(?:\d*|&)>>?\s*(&?)([^\s;|&)]*)/g)) {
    if (!harmlessTarget(m[1] === "&", m[2])) return true;
  }
  return false;
};
const writesFile = (segment) => writesFileByRegex(segment) || writesFileByScanner(segment);

// Per-tool argument rules for the tools that can write or run code through a flag.
const badArgs = (word, args) => {
  const has = (re) => args.some((a) => re.test(a));
  switch (word) {
    case "node": {
      if (args[0] === "--test") {
        for (const a of args.slice(1)) {
          if (REDIRECT_WORD_RE.test(a)) continue;
          if (a.startsWith("-")) {
            if (!NODE_TEST_FLAG_RE.test(a)) return `node --test flag not allowed: ${a}`;
          } else {
            if (!NODE_TEST_FILE_RE.test(a)) return `node --test only runs test files under scripts/, skills/, templates/: ${a}`;
          }
        }
        return null;
      }
      return !args[0] || !NODE_SCRIPT_RE.test(args[0]) ? "node only runs scripts/<name>.mjs" : null;
    }
    case "git": {
      // `-c`, `--config-env` and `--exec-path` run code only as git's own options,
      // before the subcommand; after it, `-c` is the subcommand's (grep counts).
      const subAt = args.findIndex((a) => !a.startsWith("-"));
      const globals = subAt < 0 ? args : args.slice(0, subAt);
      const sub = args[subAt];
      if (globals.some((a) => /^(-c|--config-env|--exec-path)/.test(a))) return "git flag can run or write";
      if (has(/^(--output|--open-files-in-pager)/)) return "git flag can run or write";
      if (sub === "grep" && args.slice(subAt + 1).some((a) => /^-[a-zA-Z]*O/.test(a))) return "git flag can run or write";
      return GIT_READ.has(sub) ? null : `git ${sub ?? ""} is not a read subcommand`;
    }
    case "sed":
      return args[0] === "-n" && !has(/^-\w*[ie]|--in-place|^-n.+/) ? null : "sed only as `sed -n`";
    case "find":
      return has(/^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fprint0|fls)$/) ? "find action can run or write" : null;
    case "sort":
      return has(/^(-o|--output)/) ? "sort -o writes a file" : null;
    case "rg":
      return has(/^--pre(=|$)/) ? "rg --pre runs a command" : null;
    case "awk":
      return has(/system\s*\(|\|\s*"|print[^;}]*>|getline/) ? "awk program can run or write" : null;
    default:
      return null;
  }
};

const withoutSubstitutions = (text) => {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (depth === 0 && text[i] === "$" && text[i + 1] === "(" && text[i + 2] !== "(") { depth = 1; i++; out += "x"; continue; }
    if (depth > 0) { if (text[i] === "(") depth++; else if (text[i] === ")") depth--; continue; }
    out += text[i];
  }
  return out.replace(/`[^`]*`/g, "x");
};

// Every refusal in the proof, outer commands and substitutions alike. The
// reason printed is the most telling one: a network tool, then a container,
// then the first refusal, so `node x.mjs $(gcloud …)` and `podman … $(seq 9)`
// name gcloud and podman.
const refusals = (run) => {
  const out = [];
  for (const seg of splitSegments(run)) {
    // Substitutions are judged on their own; blank them so `out=$(cat f)` is one word.
    let words = shellWords(withoutSubstitutions(seg));
    let word = commandWord(words);
    while (TESTERS.has(word)) {
      words = words.slice(words.indexOf(word) + 1);
      word = commandWord(words);
    }
    if (!word || LIST_KEYWORDS.has(word) || CLOSERS.has(word)) continue;
    word = word.replace(/^\/usr\/bin\//, "");
    if (!LOCAL_READ_TOOLS.has(word)) { out.push(notLocal(word)); continue; }
    if (!onPath(word)) { out.push({ ok: false, reason: `tool not installed: ${word}` }); continue; }
    const bad = badArgs(word, words.slice(commandStart(words).index + 1));
    if (bad) out.push({ ok: false, reason: bad });
    else if (writesFile(seg)) out.push({ ok: false, reason: "writes a file" });
  }
  for (const inner of substitutions(run)) out.push(...refusals(inner));
  return out;
};
const RANK = [/\(network\)$/, /\(container\)$/];
const rank = (r) => { const i = RANK.findIndex((re) => re.test(r.reason)); return i < 0 ? RANK.length : i; };

export const checkLocal = (run, root) => {
  const refused = refusals(run);
  if (refused.length) return refused.reduce((best, r) => (rank(r) < rank(best) ? r : best));
  for (const raw of run.trim().split(/\s+/)) {
    const tok = raw.replace(/^[`'"]+|[`'",;)]+$/g, "");
    if (/^(\/|~|\.\/)/.test(tok) && tok !== "/dev/null") {
      const abs = tok.startsWith("/") || tok.startsWith("~") ? expandPath(tok) : resolve(root, tok);
      if (!existsSync(abs)) return { ok: false, reason: "path absent" };
    }
  }
  return { ok: true };
};

// Keywords that open or close a compound command. `for`/`case` segments carry
// a word list, not a command; the closers carry nothing. `if`/`while`/`until`/
// `elif` are followed by the command they test, which is gated like any other.
const LIST_KEYWORDS = new Set(["for", "case", "select"]);
const CLOSERS = new Set(["done", "fi", "esac", "}", ")"]);
const TESTERS = new Set(["if", "while", "until", "elif", "!"]);

// Bodies of `$(…)` and backtick substitutions outside single quotes. A command
// substitution runs a command even inside double quotes, so it is gated too.
const substitutions = (run) => {
  const text = run.replace(/'[^']*'/g, " ");
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
      let depth = 0;
      for (let j = i + 1; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")" && --depth === 0) { out.push(text.slice(i + 2, j)); i = j; break; }
      }
    } else if (text[i] === "`") {
      const j = text.indexOf("`", i + 1);
      if (j > i) { out.push(text.slice(i + 1, j)); i = j; }
    }
  }
  return out;
};

// Every command in `run` (each pipeline stage, each `;`/`&&`/`||` segment and
// each command substitution) must be in `tools`. This is the gate a
// `kind: file` live value needs, since it must run on a CI runner with no
// auth. checkLocal's first-word test passes
// `jq ".mcpServers|length" mcp-servers.json | gh api repos/x`.
export const checkQuerySegments = (run, tools = LOCAL_TOOLS) => {
  for (const inner of substitutions(run)) {
    const r = checkQuerySegments(inner, tools);
    if (!r.ok) return r;
  }
  for (const seg of splitSegments(run)) {
    let words = shellWords(seg);
    let word = commandWord(words);
    while (TESTERS.has(word)) {
      words = words.slice(words.indexOf(word) + 1);
      word = commandWord(words);
    }
    if (!word || LIST_KEYWORDS.has(word) || CLOSERS.has(word)) continue;
    if (!tools.has(word)) return { ok: false, reason: `command not allowed: ${word}`, word };
  }
  return { ok: true };
};

export const clip200 = (s) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 200);

// The stages of the command's LAST pipeline, in order (the one PIPESTATUS reports).
const lastPipelineStages = (run) => {
  const segs = splitSegmentsDetailed(run).filter((s) => s.text.trim() !== "");
  let start = segs.length - 1;
  while (start > 0 && segs[start].sep === "|") start--;
  return segs.slice(start).map((s) => s.text.trim());
};

// 141 = 128 + SIGPIPE: a stage whose reader (`head -1`) closed early. Not a failure.
const SIGPIPE_STATUS = 141;

// The first earlier stage whose status says it died, as a report line, else "".
// A pipeline's own exit code is its LAST stage's, so a dead first stage leaves
// `| wc -w` printing a confident 0. Only exit 2 or more counts, minus SIGPIPE:
// exit 1 is "no match" or "false" for too many tools (grep, git grep, git diff
// --quiet, jq -e, awk 'END{exit !f}', a loop whose last test was false) to read
// as death. A compound stage (`done`, `fi`, `}`) is labelled by nothing.
const deadStage = (run, statuses) => {
  const stages = lastPipelineStages(run);
  const known = stages.length === statuses.length;
  for (let i = 0; i < statuses.length - 1; i++) {
    const st = statuses[i];
    if (st < 2 || st === SIGPIPE_STATUS) continue;
    const word = known ? commandWord(shellWords(stages[i])) : "";
    const cmd = LIST_KEYWORDS.has(word) || CLOSERS.has(word) ? "" : word;
    return `stage ${i + 1}${cmd ? ` (${cmd})` : ""} exited ${st}`;
  }
  return "";
};

// Run one command with bash -c in `root`. Never throws: a non-zero exit, a
// timeout or a spawn error comes back as { ok: false, timedOut, output }, where
// output is the text a report prints (clipped stdout + the error), never empty.
// Two opt-in checks for a numeric value, both about an exit-0 run that should
// not be trusted (a pipeline reports only its LAST stage):
//   failOnStderr: the command wrote to stderr (BSD grep has no -P: it
//     complains and prints nothing, so `| wc -w` prints 0);
//   deadStages: an earlier pipeline stage exited non-zero (see deadStage), which
//     catches the same dead stage when the author wrote 2>/dev/null.
export const runCommand = (run, { root, timeoutMs, failOnStderr = false, deadStages = false }) => {
  // PIPESTATUS of the last pipeline goes out on fd 3; `exit` keeps the last stage's status.
  const script = deadStages
    ? `${run}\n__lv_ps=("\${PIPESTATUS[@]}")\nprintf '%s ' "\${__lv_ps[@]}" >&3\nexit "\${__lv_ps[$((\${#__lv_ps[@]} - 1))]}"`
    : run;
  const r = spawnSync("bash", ["-c", script], {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe", ...(deadStages ? ["pipe"] : [])],
  });
  if (!r.error && r.status === 0) {
    if (failOnStderr && r.stderr.trim()) return { ok: false, timedOut: false, output: clip200(`stderr: ${r.stderr}`), raw: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
    if (deadStages) {
      const statuses = String(r.output?.[3] ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
      const dead = statuses.length ? deadStage(run, statuses) : "";
      if (dead) return { ok: false, timedOut: false, output: clip200(dead), raw: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
    }
    return { ok: true, stdout: r.stdout };
  }
  const message = r.error ? r.error.message : `Command failed: ${run}\n${r.stderr ?? ""}`;
  const out = clip200((r.stdout ?? "") + " " + message);
  const timedOut = /ETIMEDOUT|timed out/i.test(String(r.error?.message ?? ""));
  return {
    ok: false,
    timedOut,
    output: timedOut ? `timed out after ${timeoutMs} ms ${out}`.trim() : (out || "exit without output"),
    // The command's whole output, for a caller that shows more than `output`'s 200 characters. Unredacted: the
    // caller decides what may be shown.
    raw: `${r.stdout ?? ""}\n${r.stderr ?? ""}`,
  };
};
