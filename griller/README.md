# griller

A Claude Code mod for a grill where you answer before you see Claude's recommendation. Claude interviews you in rounds, as in Matt Pocock's [grill-me](https://www.aihero.dev/skills-grill-me): each round is every question whose prerequisites are settled, each with Claude's recommended answer, until nothing is left open and you confirm a shared understanding. The one difference: each recommendation stays hidden until you have recorded your own answer.

A recommendation shown with the question anchors the answer. Deciding before seeing the AI's suggestion reduces overreliance on it ([Buçinca, Malaya and Gajos, CSCW 2021](https://www.eecs.harvard.edu/~kgajos/papers/2021/bucinca2021trust.shtml)). Asking Claude to hold its recommendation back is not enough: it would then form one after reading yours. So Claude writes each recommendation in its reply, before your answer exists, and the mod hides it from you until you have answered.

## Install

```
/plugin marketplace add bengous/claude-code-plugins
/plugin install griller@bengous-plugins
```

## Use

Run `/griller:grill <topic>`, such as `/griller:grill the migration plan`. Claude writes each round in its reply:

```
❓ **Q1** - **<title>**: <question, with choices written **(a)**, **(b)** when it has some>

➡️ <Claude's recommended answer>

---
```

The chat shows the questions and hides every ➡️ part, while the reply streams too. Once Claude's turn ends, a Grill pane opens beside the chat with one card per question:

- **(a)**, **(b)**, **(c)**: a question that offers choices has a button per choice. A click records that choice.
- **Record**: records what you wrote in the field, with Enter or the button. Typing alone records nothing. Once a question is answered, its text dims and Record becomes **Update**.
- Recording an answer shows Claude's recommendation under it, with **Use Claude's** to take it in place of yours.
- **Peek at Claude's** shows the recommendation before you answer; **Hide** hides it again.
- **Send answers** appears once every question is answered, beside a count of the answers and of the recommendations you used. It sends your answers to Claude as your next message.

Claude reads each answer, and when you saw its recommendation: seen before answering, or seen after answering, with your first answer when you changed it. Then it asks the next round.

## Why it is built this way

griller has three requirements. Claude fixes its recommendation before your answer exists. You see the recommendation only once you have answered. And a grill takes as little of Claude's context as it can, since that context is what Claude works with.

Four ways can carry a round from Claude to a pane and the answers back:

| Way | What it is | Fit for griller |
|---|---|---|
| An MCP server | An external process that gives Claude tools | Made to reach an external system. It cannot draw a pane, and its tool definitions sit in Claude's context on every request. |
| A channel | An MCP server that pushes events into a running session, opted in with `--channels` | Made for events from outside while nobody is at the screen. Here you are at the screen, and the answers come from inside Claude Code. |
| A mod tool | A tool the mod registers with `$.tool.register`, listed to Claude as `mcp__griller__ask`, that waits on the pane and returns the answers as its result | Meets the first two requirements: the recommendation is fixed in the call's input. But its definition rides in every request, grill or not, and the call waits by polling, since a hook's own time is capped. |
| Text and a skill | Claude writes the round in its reply; the mod hides the recommendations from the chat, reads the round when the turn ends, and sends your answers back as your next message | Meets all three: the recommendation is written before your answer exists, nothing of griller is in Claude's context until you run `/griller:grill`, and nothing waits. |

griller takes the last one. The `/griller:grill` skill sets `disable-model-invocation`, so its description stays out of Claude's context; its text enters the conversation once, when you run it. Claude writes each round as plain text, and your answers come back as one short message that repeats none of the questions.

Measured with `claude -p`, as the difference in input tokens with and without each text, on one 3-question round:

| | Mod tool | Text and skill |
|---|---|---|
| On every request, grill or not | 591 | 0 |
| Once, when a grill starts | 0 | 396 |
| A round: what Claude writes | 724 | 730 |
| A round: what Claude reads back | 621 | 73 |

What the text way costs in return is in Limits: it depends on Claude keeping the round format, and it hides recommendations by redrawing the chat, not by keeping them out of the stored reply.

The round is read from the transcript, so a mod reload or a restarted session opens again the round nobody has answered, without what you had typed and not recorded.

## Limits

- Claude is told never to state a recommendation outside its ➡️ part; the mod cannot check that.
- A round Claude writes in another format opens no pane.
- The terminal's ctrl+o transcript shows replies as stored, recommendations included.
- The pane needs a terminal or the desktop app: the mobile app draws no answer field.
