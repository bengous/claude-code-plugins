---
name: meta-prompt
description: Write the prompt another Claude will act on, from a rough request or the conversation so far, carrying the user's intent at the user's level of certainty. Use when the user asks for a prompt, meta-prompt, brief or handoff for a separate session, or wants to delegate the task just discussed to a fresh instance.
argument-hint: "<rough request>"
allowed-tools: Read, Grep, Glob
---

# Meta Prompt

Write the prompt another Claude will act on. The reader is capable and starts cold: it has
none of this conversation, only what you write, what its harness loads, and what it can read.
Give it what only this conversation knows, and leave it the work it does better than a
script: planning, exploring, choosing how.

## Input

**$ARGUMENTS**

No arguments: the request is the task discussed in this conversation.

## Carry the user's intent, not yours

The reader takes every line of the prompt as the user's intent. A plan, a library, a file
layout, a scope, a done criterion or an example the user did not give becomes, once written,
a decision the user never took.

- Each decision the user took goes in with the reason they gave, in their terms. A rule
  without its reason gets applied where it does not fit.
- Each option the user ruled out goes in with why, so the reader does not propose it again.
- What the user left open is said plainly: "I have not decided whether X" carries the
  certainty. Hedges ("ideally", "if possible") read as permission to do less.
- What counts as done is the observable result the request names, in the user's words. When
  it names none, say so and leave the reader to judge whether that needs asking.
- When the user is exploring (unsure, thinking aloud, comparing), say so: the reader thinks
  it through with the user and changes nothing until the user decides.
- Open questions go into the prompt for the reader to raise when they matter. Do not ask
  them here.

When you brief a subagent for your own work, what you need back (its output format, the
evidence it must show) and what it may touch (read only, edits, commits, which worktree) are
yours to set, and you set them: the prompt is all the subagent receives. The rule above
governs the user's decisions, not your request.

## What the reader needs

Lead with what the user wants and why it matters to them: the reason lets the reader settle
the cases nobody listed. Then carry what the reader cannot recover on its own: the facts that
produced the request (a failure observed, a test run, a constraint met), and what was tried
and what it showed. Add the side effects the user allowed and the points where they want the
reader to stop and ask, when they said so.

Leave out what the reader gets anyway. A fresh session in the same repository, and any
subagent but Explore, Plan or one whose definition sets `omitClaudeMd`, loads its own
`CLAUDE.md`, `AGENTS.md` and rules. Restate a rule only when it bears on this task and is
easy to miss, or, for a reader that starts without them, the ones that bear on the task. Say
which directory the reader starts in when the task spans more than one project, since what
it loads depends on it. A fork inherits the conversation and needs only its task.

No shorthand from this conversation ("as discussed", "the earlier approach"): every
reference resolves for a reader with zero context.

## Point, don't copy

Name the files, symbols, commands, issues and plans the reader should start from, each with
what it holds: the reader opens them itself, and a path ages better than a summary. Check
that each exists and report it as a fact: exists at path, does not exist, already done in
path, unverified. When the repository contradicts the request, say so and keep the request
as the user made it; retargeting is the reader's conversation with the user. Pointing at
prior art the reader would otherwise have to rediscover is fine; designing the solution is
the reader's work.

When the work depends on a skill the reader would not load by itself, name it. Redact
secrets, tokens and personal data, and say where the reader can get them if it needs them.

Do not execute the task you are writing the prompt for.

## Form

Order the prompt as the reader uses it: what the user wants and why; what is decided and
what is ruled out; what is open; where to start. Prose carries the intent, the decisions and
their reasons; a list is for items that are truly separate, such as the pointers. The length
is what the task needs: a short request with nothing decided stays a few lines.

A prompt the user pastes is the user's own message: write it in the first person, in the
user's language. A prompt you give a subagent is yours: attribute the user's decisions to
the user, in the language its instructions call for.

## Output

A prompt for the user to paste: your entire response is the prompt, with no preamble, fence
or closing line, since the user pastes it as is. A prompt for a subagent: it is the input of
your Agent call.
