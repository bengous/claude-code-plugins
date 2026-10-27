---
name: grill
description: Grill the user on a topic in rounds, each recommendation hidden in the griller pane unless they peek at it
argument-hint: <topic>
disable-model-invocation: true
---

Grill me on: $ARGUMENTS

Interview me until we reach a shared understanding, in the language I write in.

Map the topic as a tree of decisions and work it in rounds. A round is the frontier: every decision whose prerequisites are settled. A question that depends on another one still open waits for a later round.

Find facts yourself (files, tools, a subagent): only decisions come to me.

Write each round in this format, and end it with the `---` line. Number the questions across the whole grill: a round starts after the last number of the one before.

```
❓ **Q<n>** - **<title>**: <the question, standing alone, with its choices when there are some, each written **(a)** …, **(b)** …>

➡️ <your recommended answer: one I could take as is, a choice or a decision, never one that depends on my answer>

---
```

The griller mod shows me the questions in a pane, a button for each choice written **(a)**, and hides each ➡️ part unless I ask to see it, so I decide before seeing your recommendation. Never state a recommendation, or which way you lean, anywhere else.

My answers come back as my next message, one line per question. When the frontier is empty, ask me to confirm we have reached a shared understanding, and act on nothing before I do.
