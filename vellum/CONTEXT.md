# Vellum

A tool that hosts workshops, where humans and agents iterate on ideas until they agree on a plan.

## Language

### Workshop

**Workshop**:
One collaboration held with Vellum, from `/vellum:start` to approval: its participants, its steps, its documents and their versions.
_Avoid_: workspace, session

**Mode**:
Whether a Claude Code session takes part in a workshop: on from `/vellum:start` until an approval or `/vellum:stop`.
_Avoid_: planning mode, live (for on)

**Version**:
A recorded text of the plan, numbered from v1; a workshop may have none and still be productive.
_Avoid_: phase, drafting, in review (as stages a workshop goes through)

**Approval**:
A human's decision that the plan is agreed; it turns the mode off and renames the working directory into the final directory.

**Working directory**:
The folder that holds a workshop's files until approval.
_Avoid_: workspace, wip directory, workdir

**Final directory**:
The working directory once approval has renamed it after the plan's title.

### Participants

**Participant**:
A human or an agent: whoever brings ideas to a workshop.
_Avoid_: actor, user

**Human**:
A person taking part in a workshop; humans review, answer and decide, and a workshop may have several.
_Avoid_: user, reviewer (for the person)

**Agent**:
An AI participant: the facilitator or a subagent.
_Avoid_: robot, Claude (for the role)

**Facilitator**:
The agent that leads the workshop's work with the humans: it proposes steps and ideas, asks the grill's questions, calls subagents and writes the plan, while humans accept, challenge and decide.
_Avoid_: orchestrator, main agent, lead agent

**Subagent**:
An agent launched for one task, by the facilitator or by a human through Vellum, to create an artifact or make an agent review.

**Vellum**:
The tool that hosts workshops: its page, its band and its tools carry what participants do, while the participants choose the path.
_Avoid_: engine (for Vellum acting), workshop (for the tool)

### Documents

**Plan**:
The document a workshop seeks agreement on; it has versions.

**Artifact**:
Any other document made in the working directory: a mockup, a prototype, a board, a transcript, an agent review's verdict, an image.
_Avoid_: asset

**Cited file**:
A file of the project that a document cites.

**Document**:
What the page shows: the plan, an artifact or a cited file.

### Review

**Review**:
One reviewer's examination of a document and the feedback it yields.
_Avoid_: plan review (for the workshop or for a batch)

**Reviewer**:
A human or an agent doing a review. A human's review outranks an agent's.

**Agent review**:
A review a subagent makes on request, from a given angle and with a given severity.
_Avoid_: plan review, second opinion

### Feedback

**Comment**:
A remark on a document, anchored to a passage, an element, or the whole document.
_Avoid_: annotation

**Choice**:
An option a human picks among those the facilitator marked in a mockup.

**Answer**:
A human's reply to one question of a grill.

**Edit**:
A human's rewrite of the plan's text; sent, it becomes the next version.

**Feedback**:
What humans send the facilitator, batch by batch: comments, choices, answers, edits.

**Draft**:
What a human has prepared and not sent yet: comments, choices, answers, an edit.
_Avoid_: pending, unsent (as nouns)

**Send**:
The act that turns what the draft shows at that moment into one batch.

**Batch**:
Everything one Send delivers at once to the facilitator, whatever it concerns: comments on any document, choices, answers to an open grill, an edit.
_Avoid_: lot, feedback file, plan review

### Steps

**Step**:
A unit of work a participant chooses, which then lives: a grill, an agent review, a mockup, a prototype, the plan, or a human's own. Vellum follows the life of some steps, today the grill and the agent review.
_Avoid_: move, activity

**Proposal**:
How the facilitator offers the next steps, one of them recommended, for a human to pick; Vellum follows it too, but it is not a step.

**Hold**:
The state of a workshop while a step that needs the plan stable is under way, today a grill or an agent review: versions and new steps wait, feedback still goes.
_Avoid_: lock, freeze

### Grill

**Grill**:
A dialogue in which the facilitator asks rounds of questions and humans answer, to settle open choices.

**Round**:
The questions the facilitator asks at once in a grill.

**Transcript**:
The grill's own document: its rounds, the answers beside their questions, and what was said between them.

**Board**:
An artifact that lays out each open question of a grill: what is known, what the facilitator sees and what it proposes; a grill may be run with one.
_Avoid_: planche (in the code's English)

### What Vellum shows

**Band**:
The line Vellum keeps above Claude Code's prompt: the plan's version, the steps under way, the pill, the page's link.
_Avoid_: stage, status line

**Pill**:
The page's one-line summary of where the workshop stands.

**Refusal**:
Vellum's answer to something not allowed now, with its reason; every participant can read what is refused now.
_Avoid_: error (for a refusal)

**Relay**:
A prompt Vellum submits to the facilitator on a participant's behalf: a batch sent, an approval, a hold lifted.
_Avoid_: notice, channel entry
