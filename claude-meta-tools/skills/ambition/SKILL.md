---
name: ambition
description: Show higher, deeper or wider versions of a request, with what each would take, and recommend one.
argument-hint: "<request, or nothing for the task discussed>"
disable-model-invocation: true
allowed-tools: Read, Grep, Glob
---

# Ambition

A request is the user's best guess at how to reach what they want, sized by what they
believe an agent can do, and that belief can lag behind what the agent can do. Show the user
larger versions of the request, say what each would take, and recommend one. You propose
and the user chooses: nothing here changes a file, starts the work or writes the brief.

## Input

**$ARGUMENTS**

No arguments: the request is the task discussed in this conversation.

## Start from the request

Say in one sentence the outcome the request serves, as the user would recognise it. When the
conversation does not state that outcome, say the sentence is your reading. Check what the
request and the conversation name (files, tools, access this session has) so that what each
version takes is concrete: present, missing or unverified. Past what they name, write
"unverified" rather than exploring.

## Three directions

The frame is Felix Rieseberg's "How to be more ambitious".

Altitude is the goal beyond the goal. Say what the user would want to happen once the
request is done, then the step after that, up to two or three rungs: from fixing a crash to
keeping the apps crash-free. A higher rung can take the user out of the loop, and it holds
only if the agent can work alone: the data, the environments, a way to reproduce and
verify. Altitude fits a real end outcome, the kind people hold meetings about; it fits
creative work less.

Depth is the same task done as a field-leading expert would, not a bigger one. Say what a
top professional would do here that the request does not ask for, the rawest material they
would start from instead of what was already digested, the methods and tools they would
use, and what, other than the model or the user, would show the result is right. Where the
request rests on a belief, propose testing it against the raw data.

Range is a field that already solved the hard part. Restate the request with a verb instead
of a noun (not "a deck" but "getting busy people to believe a cause and decide in thirty
minutes"), then name the fields that do that verb for a living and what they do. Take
their methods, not their voice: what a short seller does to research a position, not how
one writes.

A direction with no worthwhile version for this request is left out; one that only makes
the task bigger is not worthwhile.

## Each version

For each version worth showing, give the outcome as something observable; what it takes
(the access, tools, environments or data the agent would need, each present, missing or
unverified, and any decision of the user's it would cross); what would check it outside the
model; and the first small step that would show whether it holds.

Include one version you would not recommend yet, because something it needs is missing or
unverified, with the cheapest step that settles it; leave it out when no such version is
worth the user's time. Give no cost, duration or success figure you have not measured; say
what would measure it.

Recommend the version whose check exists outside the model and whose missing pieces the
user can supply. A version with no outside check never leads, however large; when none has
one, say that none is recommended yet.

## Output

In the user's language: the sentence with the outcome the request serves; a table, the
recommended version first when there is one, with one row per version (direction, outcome,
first step); under it, one line per version with what it takes and what checks it; then two
or three sentences on why the recommendation leads, or why none does, and what the user
would have to provide. End with one line
telling the user that `/meta-prompt` turns the version they pick into a brief for another
agent.
