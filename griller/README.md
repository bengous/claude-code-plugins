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

## How it stays light

There is no tool. The `/griller:grill` skill sets `disable-model-invocation`, so nothing of griller sits in Claude's context until you run it; the skill's text then enters the conversation once. Claude writes each round as plain text, and your answers come back as one short message that repeats none of the questions.

The round is read from the transcript: a mod reload or a restarted session opens again the round nobody has answered, without what you had typed and not recorded.

## Limits

- Claude is told never to state a recommendation outside its ➡️ part; the mod cannot check that.
- A round Claude writes in another format opens no pane.
- The terminal's ctrl+o transcript shows replies as stored, recommendations included.
- The pane needs a terminal or the desktop app: the mobile app draws no answer field.
