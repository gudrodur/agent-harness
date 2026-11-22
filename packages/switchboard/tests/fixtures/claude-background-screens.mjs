// Screens of a Claude Code seat whose session record says `busy`, read from a
// live Claude Code 2.1.330 window (a throwaway seat that started background
// agents) and reduced to their shape: the reply text is replaced, the rules
// are shortened, the layout (blank lines, the footer, the agents panel under
// it) is kept as read.
//
// Claude Code records `busy` in two different states:
//   - its own turn runs: a spinner line ("* Gitifying… (8s · ↓ 98 tokens)")
//     sits above the composer and the footer carries "esc to interrupt";
//   - its turn has ended and only background agents still work: the composer
//     is empty and waiting, "✻ Waiting for N background agent(s) to finish"
//     may stand above it, and the footer lists "N background tasks" with no
//     "esc to interrupt". A message typed in this state was answered at once
//     while the agents ran on (checked on the live seat).
// A question or permission prompt raised while background agents run records
// `waiting` and draws the dialog in place of the composer.

const RULE = '─'.repeat(60);
const LABELLED_RULE = `${'─'.repeat(40)} example seat title ─`;
const PANEL = [
  '',
  '  ● main',
  '  ◯ general-purpose  waiting on 1 shell · Sleep 300 seconds · since 5:16',
  '  ◯ general-purpose  Sleeping 20 seconds (call 6 of 12)                  2m 20s · ↓ 27.2k tokens',
];

// The turn ended, two background agents run, the prompt waits.
export const BACKGROUND_AT_PROMPT = [
  '● LAUNCHED',
  '',
  '✻ Waiting for 1 background agent to finish',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on · 2 background tasks · ← 2 agents · ↓ to manage',
  ...PANEL,
].join('\n');

// The same state on a seat whose title sits in the top rule, once the waiting
// line has scrolled away (seen on a live renamed seat with nine tasks).
export const BACKGROUND_AT_PROMPT_TITLED = [
  '● The review passed and the change is queued.',
  '',
  LABELLED_RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on · 9 background tasks · ← 2 agents · ↓ to manage',
].join('\n');

// Its own turn runs (a foreground command), with the same background agents.
export const OWN_TURN_WITH_BACKGROUND = [
  '● Bash(python3 -c "import time; time.sleep(25)")',
  '',
  '* Gitifying… (8s · ↓ 98 tokens)',
  '  ⎿  Tip: Use /color and /rename to tell your sessions apart',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on · 2 background tasks · esc to interrupt · ← 2 agents · ↓ to manage',
  ...PANEL,
].join('\n');

// Its own turn, read between two spinner frames with the footer cut short at
// the window edge, so "esc to interrupt" is not on the screen: the spinner
// line alone says the turn runs.
export const OWN_TURN_FOOTER_CUT = [
  '● Agent "Install the build" finished · 3m 27s',
  '',
  '✶ Stewing… ',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on · 5 background tasks · /tasks to see subagents · …',
].join('\n');

// A footer cut before the place "esc to interrupt" takes, and no spinner line:
// nothing on the screen tells the two states apart.
export const FOOTER_CUT_NO_SPINNER = [
  '● Done.',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on · 5 background tasks · /tasks to see subag…',
].join('\n');

// A busy record over an empty composer with no background work listed.
export const BUSY_NO_BACKGROUND = [
  '● Done.',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on · ← 2 agents · ↓ to manage',
].join('\n');

// A question asked while background agents run (record status `waiting`).
export const QUESTION_WITH_BACKGROUND = [
  '● DONE',
  '',
  '✻ Waiting for 1 background agent to finish',
  '',
  '❯ Ask me which colour I want.',
  RULE,
  ' ☐ Colour ',
  '',
  'Pick a colour',
  '',
  '❯ 1. Red',
  '     Choose red',
  '  2. Blue',
  '     Choose blue',
  '  3. Type something.',
  RULE,
  '  4. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');
