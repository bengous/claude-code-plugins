# Changelog

What each version of vellum changed for the person using it, newest first.

## 0.16.0 - 2026-09-25

### Added

- A Review button in the page runs the plan reviewer agent on the version under review; its verdict is written to `reviews/` beside the plan.
- A running plan review holds the page until its answer arrives or a grace period passes, and giving up on a run stops its agent.

## 0.15.1 - 2026-09-25

### Fixed

- Vellum now runs on Windows, with its test suites green there.

## 0.15.0 - 2026-09-25

### Added

- Choose, in a mockup, adds the chosen option to the draft, marked and shown as a card there; the one Send button takes it along.

## 0.14.6 - 2026-09-25

### Changed

- Claude proposes the next step from its own extension and waits for the reviewer's pick, instead of the grill carrying it; the grill now keeps its own questions separate from that proposal.

## 0.14.5 - 2026-09-25

### Changed

- One draft, one Send: batches no longer lock, no answer is preselected, and a grill question waits for the reviewer to press Send.

## 0.14.4 - 2026-09-25

### Changed

- Everything Claude receives from the review now travels through one channel, `.review/channel.jsonl`, replacing the earlier relay.

## 0.14.3 - 2026-09-24

### Added

- A comment on a mockup element tells Claude the element's heading, name and opening tag.

### Fixed

- An element's description holds even against the mockup's own global scripts, and an older draft keeps its comments.

## 0.14.2 - 2026-09-24

### Added

- A mockup gets `artifact-design`'s fundamentals when the session has that skill, minus claude.ai's own page contract.

## 0.14.1 - 2026-09-24

### Fixed

- Holding Control from before the composer had focus no longer blocks the pointer.
- Settings opens on its own, shows the full commit, and reads the build fresh at each opening; the commit shown comes only from a repository that actually tracks the plugin.
- When the plugin is installed at the same path twice, the entry updated last is the one that wins.

## 0.14.0 - 2026-09-23

### Added

- A gear in the bar opens Settings, with About Vellum as its first section, showing the running plugin's version and commit.

## 0.13.0 - 2026-09-23

### Added

- An open grill is a panel beside the documents, its transcript readable as a document of its own; the page's body is now composable panes, so an extension can add a panel.
- Claude's proposal appears as a modal the reviewer answers, never popping up while the reviewer is typing; declining reaches Claude as a prompt.

### Changed

- The grill becomes a proposal you answer: its phase (working, asking, idle or stopped) is read off its file, one question shows at a time under chips for each round, with a recommended answer or your own, and End grill returns to the plan under a notice of what was decided.

### Fixed

- Many grill-answer edge cases: stray backslashes, multi-line or malformed questions and titles, quoting in the transcript, doubled clicks on Send or End grill, round numbering, and refusing a grill_ask with no recommendation.
- The comments panel now folds at once instead of sliding, pane gutters sit correctly next to the rail or the comments, and a proposal landing mid-typing or mid-modal no longer disrupts the reviewer.

## 0.12.2 - 2026-09-23

### Fixed

- A worktree-isolated agent keeps its own working directory: the extensions' tool.call hook now names its tools.
- A mockup label test's Control key handling is fixed once the composer has focus.

## 0.12.1 - 2026-09-23

### Fixed

- A comment on a line that only the reviewer's edit held is now removed along with that edit, the same way Discard edit already did.
- A line added beside a changed line, or below a plan missing its final newline, is now attributed to the right edit.
- Removing an edit-only line with Done keeps the comment on it instead of losing it.

## 0.12.0 - 2026-09-23

### Added

- A band above the prompt shows where the plan stands and links to the page.
- The plan reviewer agent names lines and quotes in its findings, and a parser reads its verdict.

### Fixed

- The lock also downgrades a rule-approved Monitor or PowerShell command back to the person, as it already did for Bash.
- A mockup comment whose dragged word anchor is gone falls back to its element, and dragging over a repeated word marks the right one.
- Discard edit no longer removes a passage or comment whose range extends beyond the edit itself.
- Split-view Markdown panes keep their own highlights instead of bleeding into each other.

## 0.11.4 - 2026-09-22

### Fixed

- Tool descriptions correctly say they belong to vellum planning.
- The comment sheet keeps its diagrams, focus and picks across events.
- A dragged comment mark now takes a box per line.

## 0.11.3 - 2026-09-22

### Added

- Commenting from the keyboard, and a mockup overlay that follows the pointer.

### Changed

- The composer's kept draft text is now scoped per document, instead of one draft shared across all of them.

### Fixed

- Clearing a card's edit no longer loses the last words typed.
- The notes popover's Approve button waits while the approval is in flight.
- The editor's typing stays tied to the version it was typed on.
- The grill's banner leaves focus alone, greys out Start when it isn't usable, fails without throwing, and its refused sends survive a reload.
- A card's undo now matches its decision (Done vs. Discard edit) and restores nothing on a locked page.
- A failed rename no longer offers a Retry approval while the editor is open.
- A replaced line is now followed correctly, and a removed passage keeps its version's lines and can come back.
- A code block's added lines are highlighted correctly under the code.

## 0.11.2 - 2026-09-22

### Added

- Edits and changes are tracked, with notices derived from the current state, and the draft carries whatever is typed into it.

### Fixed

- The skip link's target now takes focus.
- Two previews stopping together no longer fight over the plans folder.
- A popover closes with Escape from anywhere on the page.
- The rail ignores the second click of a double click.

## 0.11.1 - 2026-09-22

### Added

- A layout gutter for handles, a status bar, and landmark regions in the shell.
- Popovers, placed near their target inside the pane.

### Changed

- The colour palette is reworked to keep its contrast ratios in both light and dark themes.

## 0.11.0 - 2026-09-22

### Added

- A mockup now takes a drag as well as a click to comment, and responds to the "C" key.

### Changed

- One Comment switch, off by default, replaces the separate Select and Pinpoint modes.

### Fixed

- The working directory used is the project's own; a link that led outside it no longer does.
- The lock no longer misreads a backslash as a path separator on POSIX systems.
- A composer whose place was lost to a reload stays where it was.
- A drag now only counts as the primary mouse button's, and a click alone still picks nothing when no place was chosen.

## 0.10.1 - 2026-09-21

### Fixed

- The lock asks the file system where a path actually lands, on every platform, fixing a long Windows path (`\\?\C:\...`) that slipped past it and a Windows bug that denied every write, including the working directory.
- On a narrow window, the comments panel no longer covers the rail's fold handle, and a folded rail now says what it hides.

## 0.10.0 - 2026-09-21

### Added

- The document rail can fold, via a handle labelled "Documents".

## 0.9.4 - 2026-09-21

### Fixed

- The plugin now names its own JSX runtime, so the installed page builds correctly.

## 0.9.3 - 2026-09-21

### Fixed

- A link to the working copy now shows the plan in place instead of opening a new tab, and reads the working copy before a name that only another document ends with.

## 0.9.2 - 2026-09-21

### Fixed

- Nothing under `.review/` shows up any more as a file the plan can cite.
- The sheet's fourth row is held correctly, and a failed transcript load names the file it failed on.

## 0.9.1 - 2026-09-21

### Fixed

- A failed load of the grill's blocks now reaches the banner, and a Markdown document that fails to load says so where the wait indicator was.
- A selection bug in the Markdown view no longer breaks the mouse-up handler.
- The preview follows the review wherever it was moved.

## 0.9.0 - 2026-09-21

### Added

- The page can be served on any directory of documents, working from a copy it takes away.
- The document plate shows the plan's comment count.

## 0.8.0 - 2026-09-21

### Added

- The plan appears as its own plate in the rail, labelled draft or v<n>.
- Cited files sit in their own group, showing their folder instead of a document kind; the rail groups documents as plan, artifact or cited.

## 0.7.4 - 2026-09-21

### Fixed

- Line numbers (`data-lines`) are now read from a single, correct source.

## 0.7.3 - 2026-09-21

### Fixed

- Several small faults that compiled, or failed silently, are corrected.

## 0.7.2 - 2026-09-21

### Fixed

- The page now correctly parses what the mockup's frame posts to it.

## 0.7.1 - 2026-09-21

Internal changes only: tests, docs or refactoring.

## 0.7.0 - 2026-09-20

### Added

- The comments panel can fold, with its handle showing the total comment count.
- A new Tag chip element in the design kit.

### Fixed

- Button and Chip no longer forward a ref they shouldn't.
- A diagram's type now drives its figure's CSS, and its nodes cast no unwanted shadow.
- A list item's margin fillet stops before its nested list, and a quote's fillet joins its paragraphs correctly.
- A commented diagram carries its fillet, Mermaid is told when the page is dark, and a commented added block keeps its green bar.

## 0.6.0 - 2026-09-18

### Added

- A margin fillet marks each commented block, with capital-letter labels for the last three.
- Mermaid diagrams and the mockup overlay now draw using the page's own design tokens.
- The design kit's five page components, and the dark theme is finished with two embedded font families.

## 0.5.1 - 2026-09-18

Internal changes only: tests, docs or refactoring.

## 0.5.0 - 2026-09-18

### Added

- The reviewer can grill Claude directly in the page, backed by a state machine and a server that holds the conversation.

## 0.3.1 - 2026-09-17

### Added

- The reviewer can edit the plan directly; the edit is recorded as the next version.
- A passage can be marked for deletion or with a quick label, from the composer.
- The rendered plan shows what changed since the previous version.
- An approval can carry a note, and approving warns first if it would discard unsent comments.
- Unsent comments and edits survive a page reload.

### Changed

- The plan now submits automatically when Claude's turn ends, instead of waiting for Claude to send an explicit submit signal.

### Fixed

- The mode's record is kept correctly across `/clear`, closing only the mode a turn actually entered.
- The plugin's own name no longer appears in its log lines or deny reasons.

## 0.3.0 - 2026-09-16

### Added

- The reviewer is told the page's link when a review starts.
- The review mode closes automatically on `/clear` and `/resume`.

### Changed

- The command to start a review is renamed from `/vellum:plan` to `/vellum:start`.
- The page now shows what Claude writes as it writes it, instead of only once at submission.

### Fixed

- A path outside the project is handed to the session's normal flow instead of being caught by the lock; the lock now fails closed, letting only the session's own scratchpad through.
- The lock no longer blocks the session's scratchpad, and a dead review server restarts on the directory the plan was started in.
- The mockup's frame no longer loses the Ctrl key state on blur; an id-less element selector anchors correctly at the body.
- Mermaid's error graphic no longer leaks into the page, and every diagram gets its own id regardless of which pane draws it.
- The page falls back to the plan when the selected document leaves the list, and a drafting batch stays pending once the plan is gated.
- The reviewer's unsent comments are kept when Claude submits.

## 0.2.0 - 2026-09-16

### Added

- The reviewer can comment while Claude is still drafting, and can pinpoint an element of an HTML mockup from inside its sandbox.
- The rendered plan gets coloured code and drawn Mermaid diagrams.
- Comments can pinpoint a Markdown block whole, inline text, fenced code, a table, a row or a cell, or several passages at once; holding Ctrl highlights and lets through the target being added.

### Changed

- The plan review now runs in a mode vellum holds itself, instead of borrowing the native plan mode: a lock on the working directory, a `submit` signal from Claude, and a `/vellum:stop` skill to leave.

### Fixed

- The lock is anchored to the project root, not to the session's current directory, so it no longer moves when the model changes directory.
- The plan is listed once under review, and a batch is never named twice.
- Rendered Markdown links, and the wash covering a pinpointed list item's bullet, are corrected.
- Markdown tables are sized so edge cells stay reachable.

## 0.1.0 - 2026-09-15

### Added

- The plugin (renamed from plan-frontiers to vellum) introduces a `/vellum:plan` skill: exiting plan mode opens a review server so a reviewer can look over Claude's plan.
