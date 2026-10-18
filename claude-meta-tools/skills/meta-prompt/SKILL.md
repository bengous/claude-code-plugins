---
name: meta-prompt
description: Write the prompt another Claude will act on, from a rough request or the conversation so far, carrying the user's intent at the user's level of certainty. Use when the user asks for a prompt, meta-prompt, brief or handoff for a separate session, or wants to delegate the task just discussed to a fresh instance.
argument-hint: "<rough request>"
allowed-tools: Read, Grep, Glob
---

# Meta Prompt

Write the prompt another Claude will act on. The reader is capable and, unless it is a fork
of this conversation, starts cold: it has none of this conversation, only what you write,
what its harness loads, and what it can read. Give it what only this conversation knows, and
leave it the work it does better than a script: planning, exploring, choosing how. A fork
inherits the conversation and needs only its task.

## Input

**$ARGUMENTS**

No arguments: the request is the task discussed in this conversation.

## Carry the user's intent, not yours

The reader takes every line of the prompt as the user's intent. A plan, a library, a file
layout, a scope, a done criterion, an example or a reason the user did not give becomes,
once written, a decision the user never took.

- Each decision the user took goes in with the reason they gave, in their terms, or bare
  when they gave none. A rule without its reason gets applied where it does not fit; a
  reason you supply gets generalized as the user's.
- Each option the user ruled out goes in, with why when they said why, so the reader does
  not propose it again.
- A preference the user stated ("ideally reuse X") stays a preference, in their words. What
  the user left open is said plainly: "I have not decided whether X". Do not render an
  undecided point with a hedge of your own ("if possible"): the reader takes it as
  permission to do less.
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

Leave out what the reader gets anyway. A fresh session, and most subagents, load their own
instruction files (`CLAUDE.md` and what it imports, the rules): restate a rule only when it
bears on this task and is easy to miss. A reader that loads none of them, as some built-in
agents do (Claude Code docs, Subagents, "What loads at startup"), gets every rule that bears
on its task. Say which directory the reader starts in when the task spans more than one
project, since what it loads depends on it.

No shorthand from this conversation ("as discussed", "the earlier approach"): every
reference resolves for a reader with zero context.

## Point, don't copy

Name the files, symbols, commands, issues and plans the reader should start from, each with
what it holds: the reader opens them itself, and a path ages better than a summary. Check
that each file and symbol exists, and report the result as your finding, not the user's:
"a check by the session that wrote this found it at path", "found nothing", "already done
in path". A command, an issue or a plan you cannot open is passed on as the conversation
gave it. When the repository contradicts the request, report that the same way and keep the
request as the user made it; retargeting is the reader's conversation with the user.

The checks cover what the request and the conversation name. A pointer beyond that, such as
prior art the reader would otherwise rediscover, is your find: say so and offer it as one
place to look. Do not search the repository for where the work should go; the choice among
candidates is the reader's, and a pointer you pick becomes a decision the user never took.

When the work depends on a skill the reader would not load by itself, name it. Redact
secrets, tokens and personal data, and say where the reader can get them if it needs them.

Do not execute the task you are writing the prompt for.

## Form

Order the prompt as the reader uses it: what the user wants and why; what is decided and
what is ruled out; what is open; where to start. Prose carries the intent, the decisions and
their reasons; a list is for items that are truly separate, such as the pointers. The length
is what the task needs: a short request with nothing decided stays a few lines. Full
sentences, no verbal tics, no filler, the same content: cleaning the language is not
changing it.

A prompt the user pastes is the user's own message: write it in the first person, in the
user's language, with your own findings attributed to the session that wrote it. A prompt
you give a subagent is yours: attribute the user's decisions to the user, in the language
its instructions call for.

## Output

The user invoked this skill: your entire response is the prompt, with no preamble, fence or
closing line, since the user pastes it as is. You loaded it to brief a subagent of your own:
the prompt is the input of your Agent call, and your turn goes on.
