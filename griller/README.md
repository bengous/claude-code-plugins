# griller

A Claude Code mod for a grill where you answer before you see Claude's recommendation. Claude interviews you in rounds, as in Matt Pocock's [grill-me](https://www.aihero.dev/skills-grill-me): each round is every question whose prerequisites are settled, each with Claude's recommended answer, until nothing is left open and you confirm a shared understanding. The one difference: each recommendation stays hidden unless you peek at it.

A recommendation shown with the question anchors the answer. Deciding before seeing the AI's suggestion reduces overreliance on it ([Buçinca, Malaya and Gajos, CSCW 2021](https://www.eecs.harvard.edu/~kgajos/papers/2021/bucinca2021trust.shtml)). Asking Claude to hold its recommendation back is not enough: it would then form one after reading yours. So Claude writes each recommendation in its reply, before your answer exists, and the mod hides it from you unless you ask to see it.

One round in the Claude desktop app, with the scribe's transcript and journal on the right.

https://github.com/user-attachments/assets/584c3592-1e2a-4914-99f6-eac3fcb7cc26

## Install

```
/plugin marketplace add bengous/claude-code-plugins
/plugin install griller@bengous-plugins
```

## Use

Run `/griller:grill <topic>`, such as `/griller:grill the migration plan`. Claude writes each round in its reply:

```
❓ **Q<n>** - **<title>**: <question, with choices written **(a)**, **(b)** when it has some>

➡️ <Claude's recommended answer>

---
```

The chat shows the questions and hides each ➡️ part that follows a question, up to its `---`, a part Claude writes after a tool call included: it hides exactly what the pane holds as a recommendation, so a ➡️ line outside a question stays in the chat. Once Claude's turn ends, a Grill pane opens beside the chat with one card per question:

- **(a)**, **(b)**, **(c)**: a question that offers choices has a button per choice. A click records that choice.
- **Record**: records what you wrote in the field, with Enter or the button. Typing alone records nothing. Once a question is answered, its text dims and Record becomes **Update**.
- **Peek at Claude's** shows the recommendation, before or after you answer, with **Use Claude's** to take it in place of yours; **Hide** hides it again. Recording an answer never shows it.
- **Send answers** appears once every question is answered, beside a count of the answers and of the recommendations you used. It sends your answers to Claude as your next message, once the grill is saved: a save that still fails after three tries keeps the answers in the pane with the reason, and **Send anyway** sends them unsaved.

Closing the pane drops the round unsent. On a terminal narrower than 144 columns Claude Code does not place a pane nobody asked for, so the round draws in the band above the prompt instead: press ctrl+x then tab to answer there. The band has no close mark: **Drop round**, beside the count of answers, drops the round as closing the pane does.

Claude reads your final answers alone, one line per question under the number it gave it, `your recommendation` where you used its own. Then it asks the next round, its numbers following the last.

A round Claude writes while another still waits, as when you ask it something in the prompt instead of sending, takes that round's place: the round waiting is closed unsent, and each question asked again unchanged, the same number and the same text, keeps the answer you recorded for it. Its recommendation stays hidden, since it may be new; an answer you took with **Use Claude's** counts as Claude's only while its recommendation is unchanged, and as your own once Claude changed it.

## The scribe

The mod keeps the grill under `.claude/griller/` in the session's project, a folder whose own `.gitignore` keeps it out of git. None of it is sent to Claude, and it stays on your machine; Claude's tools can still open it, as any file of the project:

- `<session id>.md`: the grill as you read it, rewritten as you answer: each question as Claude wrote it, its recommendation once the round is sent, and your final answer. The round waiting shows no recommendation, so the file can sit beside the pane. A round closed unsent, by you or by a round that took its place, stays, marked abandoned, with the answers it had and no recommendation.
- `<session id>.jsonl`: the journal, one timestamped line per gesture, for analysis: a round opened, reopened, sent or closed unsent; the typing in an answer field, one line with its text once the field loses the focus or another gesture comes; each answer recorded, choice picked, peek, hide and Claude's answer taken.
- `<session id>.json`: the mod's state, the last question number, the rounds sent or abandoned and the round waiting with the answers recorded so far.

A file over 4 MiB can no longer be read or written by a mod: a journal that grows past it is left as it is, and the mod says so. A mod writes a file in place, so a process killed during a write can leave the state half written: a state file that cannot be read is left as it is, with the transcript drawn from it, the mod says so, and only the journal keeps what follows.

Once every question is answered, the pane scrolls to **Send answers**.

## Why it is built this way

griller has three requirements. Claude fixes its recommendation before your answer exists. You see the recommendation only when you ask for it. And a grill takes as little of Claude's context as it can, since that context is what Claude works with.

Four ways can carry a round from Claude to a pane and the answers back:

| Way              | What it is                                                                                                                                                                  | Fit for griller                                                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An MCP server    | An external process that gives Claude tools                                                                                                                                 | Made to reach an external system. It cannot draw a pane, and its tool definitions sit in Claude's context on every request.                                                                                   |
| A channel        | An MCP server that pushes events into a running session, opted in with `--channels`                                                                                         | Made for events from outside while nobody is at the screen. Here you are at the screen, and the answers come from inside Claude Code.                                                                         |
| A mod tool       | A tool the mod registers with `$.tool.register`, listed to Claude as `mcp__griller__ask`, that waits on the pane and returns the answers as its result                      | Meets the first two requirements: the recommendation is fixed in the call's input. But its definition rides in every request, grill or not, and the call waits by polling, since a hook's own time is capped. |
| Text and a skill | Claude writes the round in its reply; the mod hides the recommendations from the chat, reads the round when the turn ends, and sends your answers back as your next message | Meets all three: the recommendation is written before your answer exists, nothing of griller is in Claude's context until you run `/griller:grill`, and nothing waits.                                        |

griller takes the last one. The `/griller:grill` skill sets `disable-model-invocation`, so its description stays out of Claude's context; its text enters the conversation once, when you run it. Claude writes each round as plain text, and your answers come back as one short message that repeats none of the questions.

Measured with `claude -p`, as the difference in input tokens with and without each text, on one 3-question round:

|                                 | Mod tool | Text and skill |
| ------------------------------- | -------- | -------------- |
| On every request, grill or not  | 591      | 0              |
| Once, when a grill starts       | 0        | 396            |
| A round: what Claude writes     | 724      | 730            |
| A round: what Claude reads back | 621      | at most 73     |

What the text way costs in return is in Limits: it depends on Claude keeping the round format, and it hides recommendations by redrawing the chat, not by keeping them out of the stored reply.

The round waiting is read back from the scribe's state, so a mod reload, a restarted session or a resumed one, through `/resume` too, opens it again with the answers recorded, without what you had typed and not recorded, and a round already sent or dropped stays closed. A `/clear` leaves the grill with the session it ends: the pane closes, and the new conversation's grill starts from nothing, in files of its own.

## Limits

- Claude is told to give a recommendation you could take as is, and never to state one outside its ➡️ part; the mod checks neither.
- A round Claude writes in another format opens no pane, and choices not written **(a)** get no button.
- A question that takes several choices still gets one button each, and a press replaces the choice before it: you combine them by typing them, such as `a + d`.
- The journal notes no end of session: a round left open when the session ends reads the same as one still waiting, and typing that no gesture followed is not in it. Going back to the prompt does not end the typing in a field; the next gesture does.
- The terminal's ctrl+o transcript shows replies as stored, recommendations included.
- In the terminal, a round opened over earlier text can leave stray letters in the pane's blank rows; ctrl+l redraws the screen and clears them.
- The pane needs a terminal or the desktop app: the mobile app draws no answer field.
