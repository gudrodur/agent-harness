// Synthetic screens of a Claude Code seat whose session record says `busy`.
// Only the layout follows Claude Code 2.1.330 (blank lines, the footer, the
// agents panel under it); every text is made up and the rules are shortened.
//
// Claude Code records `busy` in two different states:
//   - its own turn runs: a spinner line ("* Gitifying… (8s · ↓ 98 tokens)",
//     "✢ Compacting conversation… (8s)") sits above the composer, and the
//     footer carries "esc to interrupt" unless the composer holds text or the
//     window clips it;
//   - its turn has ended and only background agents still work: the composer
//     is empty, "✻ Waiting for N background agent(s) to finish" may stand above
//     it, and the footer lists "N background tasks", ends in "↓ to manage" and
//     has no "esc to interrupt". A message typed in this state is answered at
//     once while the agents run on.
// A question or permission prompt raised while background agents run records
// `waiting` and draws the dialog in place of the composer.
//
// The empty composer line is the prompt mark and a no-break space, nothing
// else: never an ASCII space.

export const EMPTY_PROMPT = '❯\u00a0';
const RULE = '─'.repeat(60);
const LABELLED_RULE = `${'─'.repeat(40)} example seat title ─`;
const WAIT_LINE = '✻ Waiting for 1 background agent to finish';
const MODE = '  ⏵⏵ bypass permissions on';
const MANAGE_FOOTER = `${MODE} · 2 background tasks · ← 2 agents · ↓ to manage`;
const DRAFT_PROMPT = '❯\u00a0half typed draft';
const PANEL = [
  '',
  '  ● main',
  '  ◯ general-purpose  waiting on 1 shell · Sleep 300 seconds · since 5:16',
  '  ◯ general-purpose  Sleeping 20 seconds (call 6 of 12)                  2m 20s · ↓ 27.2k tokens',
];
// One screen: what stands above the composer, its rows and what stands under it.
const screenOf = ({ above = ['● Done.'], top = RULE, box = [EMPTY_PROMPT], footer = [MANAGE_FOOTER] }) => [...above, '', top, ...box, RULE, ...footer].join('\n');

// ---- the turn has ended and only background work runs ------------------------

export const BACKGROUND_AT_PROMPT = screenOf({ above: ['● LAUNCHED', '', WAIT_LINE], footer: [MANAGE_FOOTER, ...PANEL] });

// The same state on a seat whose title sits in the top rule, once the waiting
// line has scrolled away.
export const BACKGROUND_AT_PROMPT_TITLED = screenOf({
  above: ['● The review passed and the change is queued.'],
  top: LABELLED_RULE,
  footer: [`${MODE} · 9 background tasks · ← 2 agents · ↓ to manage`],
});

// A footer of several lines: a notice on the first one, an update notice and
// `/rc` on their own lines, then the agents panel.
export const BACKGROUND_FOOTER_LINES = screenOf({
  above: ['● LAUNCHED', '', '✻ Cooked for 1m 36s · done 5:36'],
  footer: [
    `${MODE} · 7 background tasks · ← 2 agents · ↓ to manage 8% until auto-compact`,
    `${' '.repeat(58)}✔ Update installed · Restart to update`,
    `${' '.repeat(93)}/rc`,
    ...PANEL,
  ],
});

// `/rc` on the footer's own line, after padding.
export const BACKGROUND_FOOTER_RC = screenOf({ above: [WAIT_LINE], footer: [`${MANAGE_FOOTER}                  /rc`, ...PANEL] });

// Agents only: the footer counts no tasks and the waiting line names them.
export const BACKGROUND_WAIT_LINE_ONLY = screenOf({ above: [WAIT_LINE], footer: [`${MODE} · ← 2 agents · ↓ to manage`] });

// ---- the review's screens -----------------------------------------------------

// A: compacting, a draft in the composer, so the footer drops its esc hint.
export const COMPACTING_WITH_DRAFT = screenOf({
  above: [WAIT_LINE, '❯ /compact', '✢ Compacting conversation… (8s)', '  ⎿  Tip: Use /theme to change the color theme'],
  box: [DRAFT_PROMPT],
  footer: [`${MODE} · 2 background tasks`],
});

// B: compacting in a narrow window, which clips the footer.
export const COMPACTING_CLIPPED = screenOf({
  above: ['❯ /compact', '✢ Compacting conversation… (56s)', '  ⎿  Tip: Use /btw to ask a side question without', '     interrupting Claude'],
  footer: [`${MODE} · 2 background tasks ·`],
});

// C: a one-word spinner above a task list, with a draft.
export const SPINNER_ABOVE_TASKS_WITH_DRAFT = screenOf({
  above: ['✶ Stewing… (1m 4s)', '  ⎿  ◻ Read the failing test', '     ◻ Fix the parser', '     ◻ Run the suite'],
  box: [DRAFT_PROMPT],
  footer: [`${MODE} · 2 background tasks`],
});

// ---- one signal each: every other sign says the seat is at its prompt ---------

// Only "esc to interrupt" says the turn runs, on the footer's first line or below it.
export const ONLY_ESC_HINT = {
  'esc on the first line': screenOf({ above: [WAIT_LINE], footer: [`${MODE} · 2 background tasks · esc to interrupt · ← 2 agents · ↓ to manage`] }),
  'esc on a later line': screenOf({ above: [WAIT_LINE], footer: [MANAGE_FOOTER, '  esc to interrupt'] }),
};

// Only a spinner line says the turn runs.
export const ONLY_SPINNER = {
  'a one-word label': screenOf({ above: ['✶ Stewing…'] }),
  'a multi-word label': screenOf({ above: ['✢ Compacting conversation…'] }),
  'a multi-word label with a timer': screenOf({ above: ['✳ Writing the failing test for #12… (2m 3s · ↑ 1.1k tokens)', '  ⎿  Tip: Use /tasks'] }),
  'a spinner above a task list': screenOf({ above: ['✢ Fixing the parser…', '  ⎿  ◻ Read the failing test', '     ◻ Fix the parser', '     ◻ Run the suite', '     ◻ Open the change'] }),
  'a reduced-motion label': screenOf({ above: ['● Thinking…'] }),
  'a reduced-motion multi-word label': screenOf({ above: ['● Compacting conversation…'] }),
  'a reduced-motion label with a timer': screenOf({ above: ['● Compacting conversation… (8s)'] }),
  'a blanked glyph with a timer': screenOf({ above: ['  Compacting conversation… (8s)'] }),
};

// Only the footer's missing or clipped "↓ to manage" leaves it unproven.
export const ONLY_FOOTER_UNPROVEN = {
  'clipped after the task count': screenOf({ above: [WAIT_LINE], footer: [`${MODE} · 2 background tasks ·`] }),
  'no manage hint': screenOf({ above: [WAIT_LINE], footer: [`${MODE} · 2 background tasks`] }),
  'clipped inside the manage hint': screenOf({ above: [WAIT_LINE], footer: [`${MODE} · 2 background tasks · ← 2 agents · ↓ to mana…`] }),
  'elided before the manage hint': screenOf({ above: [WAIT_LINE], footer: [`${MODE} · 2 background tasks · esc to inter… · ↓ to manage`] }),
  'the manage hint run into other text': screenOf({ above: [WAIT_LINE], footer: [`${MODE} · 2 background tasks · ↓ to manage·`] }),
  'no footer': screenOf({ above: [WAIT_LINE], footer: [] }),
};

// Only the composer holds something.
export const ONLY_DRAFT = {
  'a draft': screenOf({ above: [WAIT_LINE], box: [DRAFT_PROMPT] }),
  'a draft on the second row': screenOf({ above: [WAIT_LINE], box: [EMPTY_PROMPT, '  the rest of a draft'] }),
  'an ASCII-space prompt with a draft': screenOf({ above: [WAIT_LINE], box: ['❯ half typed draft'] }),
  'a paste chip': screenOf({ above: [WAIT_LINE], box: ['❯\u00a0\x1b[2m[Pasted text #1 +3 lines]\x1b[22m'] }),
  'a composer row that cannot be parsed': screenOf({ above: [WAIT_LINE], box: ['❯\u00a0\x1b[2K'] }),
};

// The draft case of the review: the waiting line, a draft, the footer as drawn.
export const WAITING_WITH_DRAFT = screenOf({ above: [WAIT_LINE], box: [DRAFT_PROMPT], footer: [`${MODE} · 2 background tasks`] });

// ---- other busy screens --------------------------------------------------------

// Its own turn runs (a foreground command), with the same background agents.
export const OWN_TURN_WITH_BACKGROUND = screenOf({
  above: ['● Bash(sleep 25)', '', '* Gitifying… (8s · ↓ 98 tokens)', '  ⎿  Tip: Use /color and /rename to tell your sessions apart'],
  footer: [`${MODE} · 2 background tasks · esc to interrupt · ← 2 agents · ↓ to manage`, ...PANEL],
});

// Its own turn, read between two spinner frames with the footer cut short.
export const OWN_TURN_FOOTER_CUT = screenOf({
  above: ['● Agent "Install the build" finished · 3m 27s', '', '✶ Stewing… '],
  footer: [`${MODE} · 5 background tasks · /tasks to see subagents · …`],
});

// A footer cut before the place "esc to interrupt" takes, and no spinner line.
export const FOOTER_CUT_NO_SPINNER = screenOf({ footer: [`${MODE} · 5 background tasks · /tasks to see subag…`] });

// A busy record over an empty composer with no background work listed.
export const BUSY_NO_BACKGROUND = screenOf({ footer: [`${MODE} · ← 2 agents · ↓ to manage`] });

// ---- dialogs -------------------------------------------------------------------

// A question asked while background agents run (record status `waiting`).
export const QUESTION_WITH_BACKGROUND = [
  '● DONE',
  '',
  WAIT_LINE,
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

// A permission prompt that opened after the message was typed: the layout of
// permission-dialog-ruled.txt, where Enter selects "Yes".
const PERMISSION = [
  '● Agent "Synthetic task" needs permission',
  '',
  RULE,
  ' Bash command',
  ' Create an empty file with touch',
  '╌'.repeat(60),
  ' touch example-file',
  '╌'.repeat(60),
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
];
export const PERMISSION_PROMPT = [...PERMISSION, '', ' Esc to cancel · Tab to amend'].join('\n');
// The same prompt with its footer not on the screen: only the missing composer
// tells, while the record still says busy.
export const PERMISSION_PROMPT_NO_FOOTER = PERMISSION.join('\n');

// The composer once a message has been typed into it, before its Enter.
export const typedInto = (text) => screenOf({ above: [WAIT_LINE], box: [`❯\u00a0${text}`], footer: [`${MODE} · 2 background tasks`] });
