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
  // A backslash escapes the next character inside double quotes and inside `$'…'` (ANSI-C
  // quoting); in plain single quotes it is a character.
  const findClose = (q, from, ansi) => {
    for (let j = from; j < text.length; j++) {
      const c = text[j];
      if (c === '\\' && (q === '"' || ansi)) {
        j++;
        continue;
      }
      if (c === q) return j;
    }
    return -1;
  };
  // Where bash reads `$'` literally, the old split stands and a quote closes at the next
  // quote character: a heredoc body with its terminator, and a quote glued to a word
  // (`a"$'\'"`, `a'x$'`), which bash opens but this splitter does not. Reading escapes
  // there would fold the next command into the span. `literalEnd` is the last index of
  // the literal stretch being read. In a `#` comment no quote opens at all (#73, below).
  // A comment is one bash sees (commentSpans): a `#` after an escaped blank (`a\ #x`), in
  // `${…}` or `$((…))`, or after a removed backslash-newline is a character, and `$'` after
  // it is ANSI-C quoting again. A comment in backticks ends at the closing backtick.
  const literal = [];
  {
    const lines = text.split('\n');
    const starts = [];
    for (let k = 0, at = 0; k < lines.length; at += lines[k].length + 1, k++) starts.push(at);
    for (const h of scanHeredocs(lines)) {
      if (h.from >= lines.length) continue;
      const end = h.to < lines.length ? starts[h.to] + lines[h.to].length : text.length;
      literal.push([starts[h.from], end]);
    }
  }
  // Inside a comment a quote or a backslash is a character up to the comment's end (#73): bash
  // opens no quote there, so one read as an opener hid every line up to the next quote character.
  const comments = commentSpans(text).sort((a, b) => a[0] - b[0]);
  for (const [from, to] of comments) literal.push([from, to - 1]);
  literal.sort((a, b) => a[0] - b[0]);
  let nextComment = 0;
  const inComment = (at) => {
    while (nextComment < comments.length && comments[nextComment][1] <= at) nextComment++;
    return nextComment < comments.length && comments[nextComment][0] <= at;
  };
  let nextLiteral = 0;
  let literalEnd = -1;
  let i = 0;
  // The previous character was a bare `$` that opens what follows: not the second `$` of
  // `$$` (the pid, so `$$'x'` is a plain single quote) and not an escaped `\$`.
  let dollarOpens = false;
  while (i < text.length) {
    const c = text[i];
    while (nextLiteral < literal.length && literal[nextLiteral][0] <= i) {
      literalEnd = Math.max(literalEnd, literal[nextLiteral][1]);
      nextLiteral++;
    }
    if (i > literalEnd && (c === '"' || c === "'") && i > 0 && !QUOTE_OPEN_PRECEDER.test(text[i - 1])) {
      literalEnd = Math.max(literalEnd, findClose(c, i + 1, false));
    }
    const ansi = dollarOpens && i > literalEnd;
    dollarOpens = false;
    if ((c === "'" || c === '"' || c === '\\') && inComment(i)) {
      cur += c;
      i++;
      continue;
    }
    if (
      (c === "'" || c === '"') &&
      (i === 0 || QUOTE_OPEN_PRECEDER.test(text[i - 1]))
    ) {
      const close = findClose(c, i + 1, c === "'" && ansi);
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
    dollarOpens = c === '$' && !ansi;
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
// A backslash-newline is removed first, where bash removes it (joinContinuations): bare,
// in double quotes, in backticks and in an unquoted heredoc body (before its terminator is
// matched). Single quotes, `$'…'`, a comment and a quoted heredoc body keep it, inside a
// `$(…)` as at the top level.
// Out of scope: history `!` expansion, word splitting of an unquoted expansion, and
// the words inside a process substitution: they come back as plain words, and
// splitSegments splits at a `|` or `;` inside `<(a|b)`, as inside `$(a|b)`, as if it
// were outside. splitSegments does not join, so an operator split by a backslash-newline
// gives different segments. A lone backslash at the very end of the text, after any
// number of joins, is kept.

// What ends a word to bash outside quotes: its blanks and operators, and no other white
// space (a carriage return and a form feed are part of a word).
const WORD_BREAK = ' \t\n;&|()<>';
// After one of these, or an assignment, the next word is still in command position.
const COMMAND_NEXT = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time', 'coproc']);
const ASSIGNS = /^[A-Za-z_]\w*(?:\[|\+?=)/;

// The text without the backslash-newline pairs bash removes before it reads the words.
// Bash applies its quoting rules afresh in each substitution, so a stack holds the open
// contexts: `"$(echo 'a')"` is single-quoted inside double quotes.
// - Removed: bare, in double quotes, in an unquoted heredoc body (before its terminator
//   is matched), and anywhere between backticks, a quote or a comment there included,
//   as bash looks for the closing backtick first.
// - Kept: in single quotes and `$'…'`, in a comment, and in the body of a heredoc with
//   a quoted delimiter, each also inside `$(…)`, and a backslash that is itself escaped.
// A `#` opens a comment only at the start of a word, that is after bash's own blanks
// (space, tab, newline) and operators (`;&|()<>`), and never after a carriage return, a
// form feed or a closed substitution glued to it; a pair removed before it does not start
// one. A `case` statement is followed as a grammar, per context, so that the `)` that ends
// a pattern does not close a `$(…)`: `case` and `esac` count only in command position (not
// after a redirection operator, nor as a pattern or an argument), `in` only right after the
// subject, and a `|` in a pattern list starts no command. A heredoc is read from the
// newline of the context that opened it (one that opens in a `$(…)` closed on its line
// is read after the outer line).
// Joining joined text changes nothing. Linear in the text.
export const joinContinuations = (input) => {
  const s = String(input ?? '');
  return s.includes('\\\n') ? readShell(s) : s;
};

// Each comment bash sees in `text`, as [start, end) offsets: from the `#` to its newline,
// or, inside a backtick substitution, to the backtick that closes it. The reader is the one
// joinContinuations uses, so a `#` counts only where it counts there.
export const commentSpans = (text) => {
  const spans = [];
  readShell(String(text ?? ''), spans);
  return spans;
};

// The reader behind joinContinuations and commentSpans: returns the joined text, and pushes
// each comment to `comments` when one is given. Bash takes a backtick substitution's text
// first (a backslash before `$`, a backtick or a backslash removed) and reads it as
// commands again, so a comment there is found by reading that text, and ends with it.
const readShell = (s, comments) => {
  const n = s.length;
  let out = '';
  let i = 0;
  let wordStart = true;
  let word = ''; // the bare start of the word being read, for reserved words and assignments
  let last = ''; // the bare character just read
  // `cmd`: top level, `$( )`, `<( )`, `( )` and a list that is part of a word (`a=( )`,
  // `@( )`); `arith`: `$(( ))`, `(( ))`; `bracket`: `$[ ]` and a subscript; `brace`:
  // `${ }`; `dq`: double quotes. Only `cmd` has comments and heredocs. `glued` says the
  // word goes on after the context closes, and `first` that a reserved word may stand here.
  // `pending` holds the heredocs opened on the current line of this context, and `cs` the
  // open `case` statements, innermost last, each in one state: `subject` (to the word after
  // `case`), `in` (to the word `in`), `pats` (at the start of a pattern list: `esac` ends the
  // statement), `pat` (in a pattern, to the `)`), `body` (the commands after it, to `;;`).
  const context = (kind, glued, list = false) =>
    ({ kind, glued, list, before: word && `${word}"`, depth: 0, cs: [], pending: [], first: kind === 'cmd' && !list });
  const stack = [context('cmd', false)];
  // A reserved word stands only where a command may start, and no pattern or subject does.
  const commandPos = (ctx) => ctx.first && (ctx.cs.length === 0 || ctx.cs.at(-1) === 'body');
  const caseState = (ctx, state) => {
    ctx.cs[ctx.cs.length - 1] = state;
  };
  // An operator's next character, past the pairs bash removes between the two.
  const skip = (from) => {
    let j = from;
    while (s[j] === '\\' && s[j + 1] === '\n') j += 2;
    return j;
  };
  const enter = (kind, opener, next, glued = true, list = false) => {
    stack.push(context(kind, glued, list));
    out += opener;
    i = next;
    wordStart = true;
    word = last = '';
  };
  const leave = () => {
    const { glued, before, pending } = stack.pop();
    // Bash reads a heredoc opened here from the lines after the one that ends the outer command.
    stack.at(-1).pending.push(...pending);
    wordStart = !glued;
    word = glued ? before : '';
    last = '';
    if (!glued) stack.at(-1).first = true;
  };
  // A quote, an escape or an expansion in a word: it is then no reserved word.
  const inWord = () => {
    wordStart = false;
    if (word) word += '"';
  };
  const endWord = (ctx) => {
    if (!wordStart) {
      const state = ctx.cs.at(-1);
      if (state === 'subject') caseState(ctx, 'in');
      else if (state === 'in') {
        if (word === 'in') caseState(ctx, 'pats');
      } else if (state === 'pats') {
        if (word === 'esac') ctx.cs.pop();
        else caseState(ctx, 'pat');
      } else if (state !== 'pat') {
        const reserved = commandPos(ctx);
        if (reserved && word === 'case') ctx.cs.push('subject');
        else if (reserved && word === 'esac' && state === 'body') ctx.cs.pop();
        ctx.first = reserved && (COMMAND_NEXT.has(word) || ASSIGNS.test(word));
      }
    }
    word = '';
  };
  // To the first backtick no backslash escapes. With `comments`, `text` is the substitution's
  // text as bash reads it again and `at` the offset in `s` of each of its characters.
  const backticks = () => {
    out += '`';
    i++;
    let text = '';
    const at = [];
    let close = n;
    while (i < n) {
      if (s[i] === '\\') {
        const next = s[i + 1];
        if (next !== '\n') {
          out += s.slice(i, i + 2);
          if (comments && next !== undefined && '$`\\'.includes(next)) {
            text += next;
            at.push(i + 1);
          } else if (comments) {
            text += s.slice(i, i + 2);
            at.push(i);
            if (next !== undefined) at.push(i + 1);
          }
        }
        i += 2;
      } else {
        out += s[i++];
        if (s[i - 1] === '`') {
          close = i - 1;
          break;
        }
        if (comments) {
          text += s[i - 1];
          at.push(i - 1);
        }
      }
    }
    if (comments) {
      for (const [from, to] of commentSpans(text)) comments.push([at[from], to < text.length ? at[to] : close]);
    }
    inWord();
  };
  // Literal to the closing quote; in `$'…'` a backslash escapes the next character.
  const quoted = (opener, from, ansi) => {
    let j = from;
    while (j < n && s[j] !== "'") j += ansi && s[j] === '\\' ? 2 : 1;
    const end = Math.min(j + 1, n);
    out += opener + s.slice(from, end);
    i = end;
    inWord();
  };
  // The delimiter word after `<<`, itself joined, with its quotes read off.
  const heredoc = (after) => {
    out += '<<';
    let j = skip(after);
    const strip = s[j] === '-';
    if (strip) {
      out += '-';
      j = skip(j + 1);
    }
    while (s[j] === ' ' || s[j] === '\t') {
      out += s[j];
      j = skip(j + 1);
    }
    let tag = '';
    let named = false;
    let literal = false;
    let quote = '';
    while (j < n) {
      const d = s[j];
      if (d === '\\' && quote !== "'") {
        const next = s[j + 1] ?? '';
        if (next !== '\n') {
          out += d + next;
          tag += !quote || '$`"\\'.includes(next) ? next : d + next;
          named = literal = true;
        }
        j += 2;
        continue;
      }
      if (quote ? d === '\n' : WORD_BREAK.includes(d)) break;
      if (d === quote) quote = '';
      else if (!quote && (d === "'" || d === '"')) {
        quote = d;
        literal = true;
      } else tag += d;
      named = true;
      out += d;
      j++;
    }
    if (named) stack.at(-1).pending.push({ tag, literal, strip });
    i = j;
    wordStart = false;
  };
  // A heredoc body, line by line to its terminator.
  const body = (doc) => {
    while (i < n) {
      let line = '';
      while (i < n && s[i] !== '\n') {
        if (!doc.literal && s[i] === '\\') {
          if (s[i + 1] !== '\n') line += s.slice(i, i + 2);
          i += 2;
        } else line += s[i++];
      }
      out += line;
      if (i < n) {
        out += '\n';
        i++;
      }
      if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.tag) break;
    }
  };
  // What a `$` opens, read past the pairs after it.
  const dollar = (inDouble) => {
    const j = skip(i + 1);
    const next = s[j];
    if (next === '(') {
      const k = skip(j + 1);
      if (s[k] === '(') enter('arith', '$((', k + 1);
      else enter('cmd', '$(', j + 1);
    } else if (next === '$') {
      out += '$$'; // the pid parameter: its second `$` opens nothing
      i = j + 1;
      inWord();
    } else if (next === '{') enter('brace', '${', j + 1);
    else if (next === '[') enter('bracket', '$[', j + 1);
    else if (next === "'" && !inDouble) quoted("$'", j + 1, true);
    else {
      out += '$';
      i++;
      inWord();
    }
  };

  while (i < n) {
    const ctx = stack.at(-1);
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] !== '\n') {
        out += s.slice(i, i + 2);
        inWord();
        last = '';
      }
      i += 2; // a removed pair leaves the word where it was
      continue;
    }
    if (c === '$') {
      dollar(ctx.kind === 'dq');
      continue;
    }
    if (c === '`') {
      backticks();
      continue;
    }
    if (c === '"') {
      if (ctx.kind === 'dq') leave();
      else stack.push(context('dq', true));
      out += c;
      i++;
      wordStart = false;
      continue;
    }
    if (ctx.kind === 'dq') {
      out += c;
      i++;
      continue;
    }
    if (c === "'") {
      quoted(c, i + 1, false);
      continue;
    }
    if (ctx.kind === 'cmd') {
      // `a=(` and the extglob `@(` go on as one word; any other `(` is an operator.
      const list = c === '(' && !wordStart && last !== '' && '=?*+@!'.includes(last);
      if (WORD_BREAK.includes(c) && !list) endWord(ctx);
      // The word after a redirection operator, or a process substitution, is no reserved word.
      if (c === '<' || c === '>') ctx.first = false;
      // `;;`, `;&` and `;;&` end a case body: a pattern list or `esac` follows.
      if (c === ';' && ctx.cs.at(-1) === 'body' && ';&'.includes(s[skip(i + 1)] ?? '\0')) caseState(ctx, 'pats');
      if (c === '\n' && ctx.pending.length) {
        out += c;
        i++;
        for (const doc of ctx.pending.splice(0)) body(doc);
        wordStart = true;
        ctx.first = !ctx.list;
        continue;
      }
      if (c === '#' && wordStart) {
        let end = s.indexOf('\n', i);
        if (end < 0) end = n;
        comments?.push([i, end]);
        out += s.slice(i, end);
        i = end;
        continue;
      }
      if (wordStart && commandPos(ctx) && /[A-Za-z_]/.test(c)) {
        // `a[1<<2]=3` shifts up to the `]`.
        SUBSCRIPT.lastIndex = i;
        if (SUBSCRIPT.test(s)) {
          word = s.slice(i, SUBSCRIPT.lastIndex);
          stack.push(context('bracket', true));
          out += word;
          i = SUBSCRIPT.lastIndex;
          wordStart = false;
          continue;
        }
      }
      if (c === '<' || c === '>') {
        const j = skip(i + 1);
        if (s[j] === '(') {
          enter('cmd', `${c}(`, j + 1);
          continue;
        }
        if (c === '<' && s[j] === '<') {
          const k = skip(j + 1);
          if (s[k] === '<') {
            out += '<<<';
            i = k + 1;
            wordStart = true;
          } else heredoc(j + 1);
          continue;
        }
      }
      if (c === '(' && !list && ctx.cs.at(-1) === 'pats') {
        // The optional `(` before a pattern: its `)` ends the list, not a subshell.
        caseState(ctx, 'pat');
        out += c;
        i++;
        wordStart = true;
        continue;
      }
      if (c === '(') {
        const j = skip(i + 1);
        if (wordStart && s[j] === '(') enter('arith', '((', j + 1, false);
        else enter('cmd', '(', i + 1, list, list);
        continue;
      }
    }
    out += c;
    i++;
    if (ctx.kind === 'brace') {
      wordStart = false;
      if (c === '}') leave();
      continue;
    }
    if (ctx.kind === 'bracket') {
      if (c === '[') ctx.depth++;
      else if (c === ']') {
        if (ctx.depth) ctx.depth--;
        else leave();
      }
      continue;
    }
    if (ctx.kind === 'arith') {
      if (c === '(') ctx.depth++;
      else if (c === ')') {
        if (ctx.depth) ctx.depth--;
        else {
          const j = skip(i);
          if (s[j] === ')') {
            out += ')';
            i = j + 1;
            leave();
            continue;
          }
          // `$((a); b)` is a substitution that opens with a subshell.
          ctx.kind = 'cmd';
          ctx.first = false;
          word = '';
        }
      }
      wordStart = WORD_BREAK.includes(c);
      continue;
    }
    if (c === ')') {
      const state = ctx.cs.at(-1);
      if (state === 'pats' || state === 'pat') {
        // The `)` that ends a pattern list; the commands follow.
        caseState(ctx, 'body');
        ctx.first = true;
        wordStart = true;
        last = '';
        continue;
      }
      if (state === undefined && stack.length > 1) {
        leave();
        continue;
      }
    }
    const redirects = c === '&' && (last === '<' || last === '>');
    last = c;
    if (WORD_BREAK.includes(c)) {
      wordStart = true;
      // An `&` that follows `<` or `>` is part of a redirection (`>&2`), not a command separator.
      if (';&|)\n'.includes(c) && !redirects) ctx.first = !ctx.list;
    } else {
      if (wordStart || word) word += c;
      wordStart = false;
    }
  }
  return out;
};
// What may follow a `$` for the shell to expand it, in double quotes and bare.
const EXPANSION_START_QUOTED = /[A-Za-z0-9_{(\[@*#?$!-]/;
const EXPANSION_START_BARE = /[A-Za-z0-9_{(\[@*#?$!'"-]/;
export const shellWordsDetailed = (segment) => {
  const text = joinContinuations(segment);
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
    // The second `$` of `$$` names the pid, so it opens no `$'…'`.
    if (c === '$' && text[i + 1] === "'" && !paramNext) {
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
