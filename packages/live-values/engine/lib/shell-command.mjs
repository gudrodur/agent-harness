#!/usr/bin/env node
// Shared shell-command cleaners for gates that judge shell commands.
//
// Every gate judges the COMMAND, not the text the command carries: a heredoc
// body is prose or an embedded program the agent did not run as a shell
// command, and a quoted span is a message, a filter pattern, or a payload.
// Judging those spans as commands fires the gate on reads (heredoc briefs
// fired a config gate on filenames mentioned in their bodies; a deployment
// listing plus quoted "deploy" prose claimed a deploy). The same shape a
// command gate strips before judging.

// Heredocs, read the way bash reads them. An opener counts only where bash
// sees one: outside quotes, comments, `${…}` and arithmetic (`$((a<<b))`,
// `$[a<<b]` and the subscript in `a[1<<2]=3` shift), and inside `$(…)` and
// `(…)`, which hold commands again
// (`git commit -m "$(cat <<'EOF'` opens one). A `<<<` herestring opens none,
// and neither does a backtick span: bash takes it whole, quotes and all, up to
// the next backtick, so a heredoc in it never reaches past it.
// The delimiter is the shell word after `<<` or `<<-`, quote-removed:
// `<<'EOF'`, `<<"EOF"`, `<<\EOF`, `<<E"OF"` and `<<'EOF bar'` each end at the
// line holding that word, and any quoting in it leaves the body unexpanded.
// A body starts below the line on which the command line ends, so a quote or
// a `\` continuation still open at the end of the opener's line defers it.
//
// A body is text the gates do not judge, so an opener read where bash sees
// none would hide every command after it. Each doubt therefore reads as no
// opener, and a terminator is matched trimmed, so a body never runs past the
// line bash ends it on. So every `name[` at a word start is read as a
// subscript, though bash reads one only in an assignment: after `declare`, or
// as a plain argument, its heredoc stays visible to the gates.
//
// Linear in the command: each character outside a body is looked at once,
// each body line once.

// Characters that end an unquoted word; a `#` after one opens a comment.
const WORD_END = /[\s;&|()<>]/;
// The contexts that hold commands: `<<` is an operator there, and a newline
// ends the command line.
const isCommandContext = (t) => t === 'top' || t === 'sub' || t === 'paren';

// The delimiter word of a heredoc, read from `line[i]` past `<<`/`<<-` and
// blanks: { tag, quoted, end }, or null when no word bash would take whole
// starts there (none, a quote left open, or an expansion inside it).
const readDelimiter = (line, i) => {
  let tag = '';
  let quoted = false;
  while (i < line.length) {
    const c = line[i];
    if (c === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) return null;
      tag += line.slice(i + 1, close);
      quoted = true;
      i = close + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '`' || (line[j] === '$' && (line[j + 1] === '(' || line[j + 1] === '{'))) return null;
        if (line[j] === '\\' && /["\\$`]/.test(line[j + 1] ?? '')) j++;
        tag += line[j];
        j++;
      }
      if (j >= line.length) return null;
      quoted = true;
      i = j + 1;
    } else if (c === '\\') {
      if (i + 1 >= line.length) return null;
      tag += line[i + 1];
      quoted = true;
      i += 2;
    } else if (c === '`' || (c === '$' && (line[i + 1] === '(' || line[i + 1] === '{' || line[i + 1] === "'"))) {
      return null;
    } else if (WORD_END.test(c)) {
      break;
    } else {
      tag += c;
      i++;
    }
  }
  return tag === '' && !quoted ? null : { tag, quoted, end: i };
};

// `case` and `esac` as words, so a pattern's `)` inside `$(…)` does not close it.
const keywordAt = (line, j, word, wordStart) =>
  wordStart && line.startsWith(word, j) && (j + word.length === line.length || /[\s;&|()]/.test(line[j + word.length]));

// An arithmetic context: `((`/`$((` closes at `))`, `$[` and a subscript at
// the matching `]`.
const arith = (close) => ({ t: 'arith', open: close === ']' ? '[' : '(', close, depth: 0 });

// `name[` at a word start: an array subscript.
const SUBSCRIPT = /[A-Za-z_]\w*\[/y;

// `$(`, `$((`, `$[`, `${` and a backtick open a context; any other character
// is passed over. Returns the next index.
const expansion = (line, j, stack, inDq) => {
  const c = line[j];
  if (c === '$' && line[j + 1] === '[') {
    stack.push(arith(']'));
    return j + 2;
  }
  if (c === '$' && line[j + 1] === '(') {
    if (line[j + 2] === '(') {
      stack.push(arith(')'));
      return j + 3;
    }
    stack.push({ t: 'sub', cases: 0 });
    return j + 2;
  }
  if (c === '$' && line[j + 1] === '{') {
    stack.push({ t: 'param', inDq });
    return j + 2;
  }
  if (c === '`') {
    stack.push({ t: 'bq' });
    return j + 1;
  }
  return j + 1;
};

// Scan one line outside a body, carrying the context stack across lines and
// pushing each opener found to `found`. `firstStartsWord` says whether the
// line's first character starts a word (false after a `\` continuation glued
// to a word). Returns { ends, nextStartsWord }: `ends` is true when the line's
// newline ends the command line, so pending bodies start below it.
const scanLine = (line, stack, found, firstStartsWord) => {
  const n = line.length;
  const wordStart = (j) => (j === 0 ? firstStartsWord : WORD_END.test(line[j - 1]));
  let continued = false;
  let j = 0;
  while (j < n) {
    const ctx = stack[stack.length - 1];
    const c = line[j];
    if (ctx.t === 'sq') {
      if (c === "'") stack.pop();
      j++;
    } else if (ctx.t === 'bq') {
      if (c === '\\') j += 2;
      else {
        if (c === '`') stack.pop();
        j++;
      }
    } else if (ctx.t === 'ansi') {
      if (c === '\\') j += 2;
      else {
        if (c === "'") stack.pop();
        j++;
      }
    } else if (ctx.t === 'arith') {
      if (c === ctx.open) {
        ctx.depth++;
        j++;
      } else if (c === ctx.close) {
        if (ctx.depth > 0) {
          ctx.depth--;
          j++;
        } else {
          stack.pop();
          j += c === ')' && line[j + 1] === ')' ? 2 : 1;
        }
      } else if (c === "'") {
        stack.push({ t: 'sq' });
        j++;
      } else if (c === '"') {
        stack.push({ t: 'dq' });
        j++;
      } else if (c === '\\') j += 2;
      else j = expansion(line, j, stack, false);
    } else if (ctx.t === 'dq') {
      if (c === '\\') j += 2;
      else if (c === '"') {
        stack.pop();
        j++;
      } else j = expansion(line, j, stack, true);
    } else if (ctx.t === 'param') {
      if (c === '\\') j += 2;
      else if (c === '}') {
        stack.pop();
        j++;
      } else if (c === '"') {
        stack.push({ t: 'dq' });
        j++;
      } else if (c === "'" && !ctx.inDq) {
        stack.push({ t: 'sq' });
        j++;
      } else j = expansion(line, j, stack, ctx.inDq);
    } else if (c === '\\') {
      // From here on a command context: top level, `$(…)` or `(…)`.
      if (j + 1 >= n) continued = true;
      j += 2;
    } else if (c === '$' && line[j + 1] === "'") {
      stack.push({ t: 'ansi' });
      j += 2;
    } else if (c === "'") {
      stack.push({ t: 'sq' });
      j++;
    } else if (c === '"') {
      stack.push({ t: 'dq' });
      j++;
    } else if (c === '#' && wordStart(j)) {
      j = n;
    } else if (wordStart(j) && ((SUBSCRIPT.lastIndex = j), SUBSCRIPT.test(line))) {
      // `a[1 << 2]=3` is arithmetic up to the `]`.
      stack.push(arith(']'));
      j = SUBSCRIPT.lastIndex;
    } else if (c === '(' && line[j + 1] === '(') {
      // `(( a << 2 ))` is arithmetic.
      stack.push(arith(')'));
      j += 2;
    } else if (c === '(') {
      stack.push({ t: 'paren', cases: 0 });
      j++;
    } else if (c === ')') {
      if (ctx.cases === 0 && (ctx.t === 'sub' || ctx.t === 'paren')) stack.pop();
      j++;
    } else if (c === '<' && line[j + 1] === '<') {
      if (line[j + 2] === '<') {
        j += 3;
        continue;
      }
      let k = j + 2;
      if (line[k] === '-') k++;
      while (line[k] === ' ' || line[k] === '\t') k++;
      const d = readDelimiter(line, k);
      if (d) {
        found.push({ head: line, tag: d.tag, quoted: d.quoted });
        j = d.end;
      } else j += 2;
    } else if (keywordAt(line, j, 'case', wordStart(j))) {
      ctx.cases++;
      j += 4;
    } else if (keywordAt(line, j, 'esac', wordStart(j))) {
      ctx.cases = Math.max(0, ctx.cases - 1);
      j += 4;
    } else j = expansion(line, j, stack, false);
  }
  return {
    ends: !continued && isCommandContext(stack[stack.length - 1].t),
    nextStartsWord: !continued || n < 2 || WORD_END.test(line[n - 2]),
  };
};

// Every heredoc in the command, in order: { head, tag, quoted, from, to },
// where `head` is the line holding the opener and lines [from, to) are its
// body; `to` is the terminator's index, or the line count when it is unclosed.
// An opener whose command line never ends (a quote left open) has no body.
const scanHeredocs = (lines) => {
  const out = [];
  const stack = [{ t: 'top', cases: 0 }];
  const found = [];
  let startsWord = true;
  let i = 0;
  while (i < lines.length) {
    const { ends, nextStartsWord } = scanLine(lines[i], stack, found, startsWord);
    startsWord = nextStartsWord;
    i++;
    if (!ends || found.length === 0) continue;
    for (const h of found) {
      const from = i;
      while (i < lines.length && lines[i].trim() !== h.tag) i++;
      out.push({ head: h.head, tag: h.tag, quoted: h.quoted, from, to: i });
      if (i < lines.length) i++;
    }
    found.length = 0;
  }
  for (const h of found) out.push({ head: h.head, tag: h.tag, quoted: h.quoted, from: lines.length, to: lines.length });
  return out;
};

// Drop heredoc bodies and their terminator lines. Head lines are kept verbatim
// so the redirect target (`cat > <target> <<EOF`) is still judged; a
// herestring's word stays on its line (the quote strip below handles its
// prose).
export const stripHeredocBodies = (command) => {
  const lines = String(command ?? '').split('\n');
  const kept = [];
  let at = 0;
  for (const h of scanHeredocs(lines)) {
    for (; at < h.from; at++) kept.push(lines[at]);
    at = Math.min(lines.length, h.to + 1);
  }
  for (; at < lines.length; at++) kept.push(lines[at]);
  return kept.join('\n');
};

// Remove single- and double-quoted spans, leaving a space so adjacent tokens
// cannot glue into a false one. Spans may cross newlines (`VAR='line1\nline2'`
// is one shell word). The opening quote must follow `=`, whitespace, a shell
// operator, or the start, so English apostrophes (`don't`, `session's`) are
// never treated as string opens.
export const stripQuoted = (text) =>
  String(text ?? '').replace(
    /(?<=[=\s([{;&|<>$`'"]|^)'(?:[^'\\]|\\.)*'|(?<=[=\s([{;&|<>$`'"]|^)"(?:[^"\\]|\\.)*"/gs,
    ' ',
  );

// The quote that may open a span: `=`, whitespace, a shell operator, or the
// start. Same gate as stripQuoted, so an apostrophe never opens.
const QUOTE_OPEN_PRECEDER = /[=\s([{;&|<>$`'"]/;

// Split a command into segments the way the guards judge them: one segment,
// one verdict, so a read in one segment neither fires for nor hides behind
// another. Quote-aware: separators inside a quoted span (`VAR='a && b'`, a
// `send-text "…; …"` message) do not split, and a multiline quoted span
// stays one segment. An unbalanced quote is treated as a literal, so it can
// never swallow the rest of the command.
export const splitSegments = (command) => splitSegmentsDetailed(command).map((s) => s.text);

// splitSegments plus the operator that PRECEDES each segment ('' for the
// first, else one of `|`, `||`, `&&`, `;`, `&`, newline). A gate that must
// know whether a command's stdin is a pipe reads `sep === '|'`; everyone
// else uses splitSegments.
export const splitSegmentsDetailed = (command) => {
  const text = String(command ?? '');
  const segs = [];
  let cur = '';
  let sep = '';
  const push = (next) => {
    segs.push({ text: cur, sep });
    cur = '';
    sep = next;
  };
  const findClose = (q, from) => {
    for (let j = from; j < text.length; j++) {
      const c = text[j];
      if (c === '\\') {
        j++;
        continue;
      }
      if (c === q) return j;
    }
    return -1;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (
      (c === "'" || c === '"') &&
      (i === 0 || QUOTE_OPEN_PRECEDER.test(text[i - 1]))
    ) {
      const close = findClose(c, i + 1);
      if (close < 0) {
        cur += c;
        i++;
        continue;
      }
      cur += text.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (c === '\\' && i + 1 < text.length) {
      cur += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    // `>|` (write even under noclobber) is one redirection operator, not a `>` and a
    // pipe: split there, `cat >| m.txt <<EOF` lost its target.
    if (c === '|' && cur.endsWith('>') && !cur.endsWith('\\>')) {
      cur += c;
      i++;
      continue;
    }
    if ((c === '&' || c === '|') && text[i + 1] === c) {
      push(c + c);
      i += 2;
      continue;
    }
    // `2>&1`, `&>file`, `>&2`: an `&` that belongs to a redirection is not a
    // separator. Before this, `cmd 2>&1` split into `cmd 2>` and `1`.
    if (c === '&' && (text[i - 1] === '>' || text[i + 1] === '>')) {
      cur += c;
      i++;
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      push(c);
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  push('');
  return segs;
};

// Split one segment into shell words. Single quotes are literal, double quotes
// honour backslash escapes, a bare backslash escapes the next character. A
// quoted span keeps its contents verbatim, `$(…)` and all: the guards that
// read a word's VALUE (a commit message, a --model name) decide themselves
// what an unexpanded `$` means. An unbalanced quote runs to the end, which is
// the allow-biased reading: the word it swallows is never mistaken for a flag.
// shellWordsDetailed gives each word as `{ word, bareStart, expands, pattern, operatorAt,
// procSubAt }`.
// - `bareStart`: its first character was neither quoted nor escaped. Only such a
//   word can be an operator, so `echo '> quote'` is an argument and `>"$f"` a redirect.
// - `expands`: the shell would expand part of it: a `$` outside single quotes that
//   starts an expansion (`$B`, `${…}`, `$(…)`, `$[…]`, a special parameter such as
//   `$?` or `$-`, and, bare, `$'…'` and `$"…"`), a backtick, a bare tilde at the
//   start or after a bare `=` or `:`, a process substitution `<(…)` or `>(…)`, or a
//   `pattern`. `$.` and `$%` stay literal. A gate reading the word as literal text
//   cannot trust it then.
// - `pattern`: a bare brace expansion (`{a,b}`, `{a..c}`, never `${`), glob (`*`, `?`,
//   `[…]`) or extglob (`@(…)`, `!(…)`, `+(…)`), also right after a whole `$$` or `$?`.
//   The shell may pass several words, or names read from the disk, so even a gate
//   that resolves variables itself cannot name the word's value.
// - `operatorAt`: the offsets in `word` of each bare `<` or `>` that starts a
//   redirection, which it does even inside a word (`echo "a">f`), so a gate can split
//   it. One followed by `(` is a process substitution, not a redirection. A `$'…'`
//   string is read with its escapes, so a `>` inside it is no operator.
// - `procSubAt`: the offsets in `word` of each bare `<(` or `>(`, a process
//   substitution. Bash passes a `/dev/fd` path to a command it runs alongside, so a
//   gate can neither read the word as a file nor know what that command writes.
// Out of scope: history `!` expansion, word splitting of an unquoted expansion, a
// backslash-newline joining two lines (an issue of its own), and the words inside a
// process substitution: they come back as plain words, and splitSegments splits at a
// `|` or `;` inside `<(a|b)`, as inside `$(a|b)`, as if it were outside.
// What may follow a `$` for the shell to expand it, in double quotes and bare.
const EXPANSION_START_QUOTED = /[A-Za-z0-9_{(\[@*#?$!-]/;
const EXPANSION_START_BARE = /[A-Za-z0-9_{(\[@*#?$!'"-]/;
export const shellWordsDetailed = (segment) => {
  const text = String(segment ?? '');
  const words = [];
  let cur = null;
  let bareStart = false;
  let expands = false;
  let pattern = false;
  let operatorAt = [];
  let procSubAt = [];
  let braces = 0; // bare `{` not yet closed in this word
  let braceSep = false; // a bare `,` or `..` since the first open one
  let bracket = false; // a bare `[` in this word
  let lastBare = null; // the character just added, when it was bare
  let paramNext = false; // the next character names the parameter of the bare `$` just added
  let lastName = false; // the bare character just added named a parameter
  let i = 0;
  const add = (s, bare) => {
    if (cur === null) bareStart = bare;
    cur = (cur ?? '') + s;
    lastBare = bare ? s : null;
    if (!bare) paramNext = lastName = false;
  };
  const push = () => {
    if (cur !== null) words.push({ word: cur, bareStart, expands: expands || pattern, pattern, operatorAt, procSubAt });
    cur = null;
    expands = pattern = braceSep = bracket = paramNext = lastName = false;
    operatorAt = [];
    procSubAt = [];
    braces = 0;
    lastBare = null;
  };
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      push();
      i++;
      continue;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close < 0 ? text.length : close;
      add(text.slice(i + 1, end), false);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && /["\\$`]/.test(text[j + 1] ?? '')) {
          s += text[j + 1];
          j += 2;
          continue;
        }
        if (text[j] === '`' || (text[j] === '$' && EXPANSION_START_QUOTED.test(text[j + 1] ?? ''))) expands = true;
        s += text[j];
        j++;
      }
      add(s, false);
      i = j + 1;
      continue;
    }
    if (c === '\\' && i + 1 < text.length) {
      add(text[i + 1], false);
      i += 2;
      continue;
    }
    if (c === '$' && text[i + 1] === "'") {
      // ANSI-C quoting: a backslash escapes the next character, `\'` included. The word keeps
      // the text undecoded, as before; it expands, so no gate reads it as literal anyway.
      expands = true;
      add('$', true);
      let j = i + 2;
      let s = '';
      while (j < text.length && text[j] !== "'") {
        const n = text[j] === '\\' && j + 1 < text.length ? 2 : 1;
        s += text.slice(j, j + n);
        j += n;
      }
      add(s, false);
      i = j + 1;
      continue;
    }
    // `$?`, `$*`, `${`, `$[` are expansions, not patterns; after a whole `$$` or `$?` the next one is.
    const param = paramNext;
    paramNext = c === '$' && !param && EXPANSION_START_BARE.test(text[i + 1] ?? '');
    if (c === '`' || paramNext) expands = true;
    if (c === '~' && (cur === null || lastBare === '=' || lastBare === ':')) expands = true;
    if (!param && (c === '*' || c === '?')) pattern = true;
    // An extglob `@(…)`, `!(…)` or `+(…)`; `?(` and `*(` are globs already. Not `$@(` or `$!(`.
    if (c === '(' && !lastName && (lastBare === '@' || lastBare === '!' || lastBare === '+')) pattern = true;
    lastName = param;
    // A process substitution `<(…)` or `>(…)`: bash passes a `/dev/fd` path, so no redirection starts.
    const procSub = (c === '<' || c === '>') && text[i + 1] === '(';
    if (procSub) {
      expands = true;
      procSubAt.push(cur === null ? 0 : cur.length);
    }
    if (!param && c === '[') bracket = true;
    if (c === ']' && bracket) pattern = true;
    if (lastBare !== '$' && c === '{') braces++; // bash never brace-expands `${`, even after `$$`
    if (braces > 0 && (c === ',' || (c === '.' && lastBare === '.'))) braceSep = true;
    if (c === '}' && braces > 0) {
      if (braceSep) pattern = true;
      braces--;
    }
    if ((c === '<' || c === '>') && !procSub) operatorAt.push(cur === null ? 0 : cur.length);
    add(c, true);
    i++;
  }
  push();
  return words;
};
export const shellWords = (segment) => shellWordsDetailed(segment).map((w) => w.word);

// Words that may precede the real command in a segment without being it.
const PREFIX_WORDS = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'then', 'do', 'else', 'if', 'while', 'until', '!', '{', '(']);
// Leading `(`, `{`, `$(` and backtick: a command opener glued to the next word.
const OPENERS_RE = /^(?:\$\(|[({`])+/;
const ASSIGNMENT_RE = /^[A-Za-z_]\w*=/;

// Where the command word sits in a segment's words: past `NAME=value`
// assignments, `env`, `sudo`, `timeout <duration>` and the other PREFIX_WORDS.
// Returns { index, env } where env holds the assignments seen (a guard can
// read `LEFTHOOK=0` off it), or index -1 when the segment is only prefixes.
export const commandStart = (words) => {
  const env = {};
  let i = 0;
  while (i < words.length) {
    const w = words[i].replace(OPENERS_RE, '');
    if (w === '') {
      i++;
      continue;
    }
    if (ASSIGNMENT_RE.test(w)) {
      const eq = w.indexOf('=');
      env[w.slice(0, eq)] = w.slice(eq + 1);
      i++;
      continue;
    }
    if (w === 'exec') {
      // `exec [-cl] [-a NAME] cmd`: the command is past the options, not `-a`.
      i++;
      while (i < words.length && /^-[acl]+$/.test(words[i])) i += words[i].includes('a') ? 2 : 1;
      continue;
    }
    if (w === 'env' || PREFIX_WORDS.has(w)) {
      i++;
      continue;
    }
    if (w === 'nice' || w === 'ionice' || w === 'xargs') {
      // Launchers with their own options: `nice -n 5`, `nice -5`, `xargs -r -n1`.
      i++;
      while (i < words.length && /^-/.test(words[i])) i += /^-[nc]$/.test(words[i]) ? 2 : 1;
      continue;
    }
    if (w === 'timeout') {
      i++;
      while (i < words.length && /^(-\S+|\d+(\.\d+)?[smhd]?)$/.test(words[i])) i++;
      continue;
    }
    return { index: i, env };
  }
  return { index: -1, env };
};

// The command word of a segment with its leading `(`/`{` removed, or ''.
export const commandWord = (words) => {
  const { index } = commandStart(words);
  return index < 0 ? '' : words[index].replace(OPENERS_RE, '');
};

// Heredoc bodies in the RAW command, one entry per opener, in order: the
// head line that opened it and the body lines up to the terminator. Mirrors
// stripHeredocBodies, which drops exactly these lines; a gate that has to
// READ a body (a message passed as `-F - <<EOF` or `-m "$(cat <<EOF)"`)
// pairs a segment with the entry whose head line carries it. `quoted` is true
// when any part of the delimiter is quoted (`<<'TAG'`, `<<"TAG"`, `<<\TAG`),
// so the shell leaves the body unexpanded and a substitution in it never runs.
// An unclosed body runs to the end of the command.
export const heredocBodies = (command) => {
  const lines = String(command ?? '').split('\n');
  return scanHeredocs(lines).map((h) => ({
    head: h.head,
    tag: h.tag,
    body: lines.slice(h.from, h.to).join('\n'),
    quoted: h.quoted,
  }));
};

// Is the text at `index` an actual command, or is it sitting inside a quoted
// string or a comment? Shared by gates that refuse a command string: without
// this a gate refuses an `echo` of a command in quotes, which does nothing —
// and refuses the very shell calls used to diagnose that. A blocking gate that
// rejects a command with no effect teaches people to route around it, so
// quote-awareness is load-bearing, not polish.
//
// This is a scanner, not a shell parser. It tracks single quotes, double quotes
// and backslash escapes, and treats an unquoted `#` as a comment to end of
// line. Anything it cannot decide it calls "not a command", because the bias of
// every gate using it is toward allowing.
export const atCommandPosition = (command, index) => {
  let single = false;
  let double = false;
  let comment = false;
  for (let i = 0; i < index; i += 1) {
    const c = command[i];
    if (comment) {
      if (c === '\n') comment = false;
      continue;
    }
    if (c === '\\' && !single) {
      i += 1;
      continue;
    }
    if (c === "'" && !double) single = !single;
    else if (c === '"' && !single) double = !double;
    else if (c === '#' && !single && !double && (i === 0 || /\s/.test(command[i - 1]))) comment = true;
  }
  return !single && !double && !comment;
};

export const matchesAtCommandPosition = (command, re) => {
  re.lastIndex = 0;
  for (let m = re.exec(command); m !== null; m = re.exec(command)) {
    if (atCommandPosition(command, m.index)) return true;
  }
  return false;
};

// Stricter than matchesAtCommandPosition: the match must also BE the command
// of its segment, with only assignments and prefix words (`sudo`, `env`,
// `timeout 30`, …) before it. `echo deploy …` carries the verb unquoted
// but runs `echo`, and a deny gate that refused it blocked a command with no
// effect. Judged per segment of the heredoc-stripped command, so
// `cd x && deploy` still matches.
export const matchesAsCommand = (command, re) =>
  splitSegments(stripHeredocBodies(command)).some((segment) => {
    re.lastIndex = 0;
    for (let m = re.exec(segment); m !== null; m = re.exec(segment)) {
      if (atCommandPosition(segment, m.index) && commandStart(shellWords(segment.slice(0, m.index))).index === -1) {
        return true;
      }
    }
    return false;
  });

// `> "$HOME/f"`, `2>'f'`: stripQuoted blanks a quoted redirect target, so a check on the stripped text
// never sees it. Yields each quoted redirect target whose operator sits outside every quoted span, as
// the match: [0] operator plus target, [1] the operator, [2] the quoted target, `.index` in `segment`.
const QUOTED_REDIRECT_RE = /((?:^|[^<>\w])(?:\d|&)?>>?\s*)("(?:[^"\\]|\\.)*"|'[^']*')/g;
export const quotedRedirects = (segment) => {
  const out = [];
  for (const m of String(segment ?? '').matchAll(QUOTED_REDIRECT_RE)) {
    // Swap the target for a bare marker, then strip quotes: the operator is a real redirect only if it
    // survives outside every quoted span.
    const marked = segment.slice(0, m.index) + m[1] + 'QTARGET' + segment.slice(m.index + m[0].length);
    if (/>\s*QTARGET/.test(stripQuoted(marked))) out.push(m);
  }
  return out;
};
