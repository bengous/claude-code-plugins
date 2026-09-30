---
name: imagegen
description: Generate or edit images with the Codex CLI's built-in image_gen tool. Use when the user asks to create, generate or draw an image, icon, logo, favicon, illustration or mockup, or to edit an existing image file — restyle, retouch, upscale, add or remove elements.
argument-hint: "<image to generate or edit> [-> destination path]"
allowed-tools:
  - Bash(${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts *)
  - Bash(ls *)
  - Bash(cmp *)
  - Bash(cp *)
  - Bash(file *)
  - Read(~/.cache/agents-bridge/**)
  - Edit(~/.cache/agents-bridge/imagegen/**)
  - Read(~/.codex/generated_images/**)
  - Edit(~/.codex/generated_images/**)
---

# Image generation via Codex

The Codex CLI ships a built-in `image_gen` tool (no API key needed). It is
exposed by **no flag** — the model calls it when the prompt asks for an image.
This skill is the thin wrapper that gets the invocation right: writable sandbox,
destination directory, output path read back reliably.

**Codex already owns the image-prompting policy** — its system skill covers
style, sizing, text accuracy, transparency and batching. Do not duplicate or
override it: pass the user's request through and let Codex augment it. Dictate
size, style or quality only when the user asked for them.

## Resolve the destination first

The tool writes into `~/.codex/generated_images/<thread-id>/` — **outside the
workspace**, under a generated filename whose shape has changed between CLI
versions, so never predict it. There is no destination argument: without an
explicit copy instruction in the prompt, the image never leaves that directory.

So before invoking, decide an **absolute** destination path. The user's request
may name one after a `->` (`a fox -> ./art/fox.png`); otherwise default to a
filename in the cwd. Resolve any relative path the user wrote **against your own
cwd**, then pass it absolute — the prompt is read inside codex, where a bare
`./x.png` means something else. `-C` must point at a directory that **contains**
the resolved destination: it is the writable workspace root, and it is what
makes the copy legal. The sandbox does not govern the tool's own write, only the
copy into the project.

## Invocation

Use the path each command prints literally in every later step: shell
variables do not survive between Bash calls.

```bash
# 1. Create the run directory; it prints <dir>:
"${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" new imagegen

# 2. Write <dir>/prompt.md  <- the image request + the two instructions
#    below. Strip any `-> destination` off the request first: it is this
#    skill's routing syntax, not part of the image description.
# 3. Run it in write mode. Add --skip-git-repo-check when -C is not inside a
#    git repo.
"${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" start <dir> --prompt-file <dir>/prompt.md --mode write -C /absolute/path/to/project
```

The prompt must end with two explicit instructions:

1. **Copy** the chosen image to the absolute destination path.
2. **Report the absolute paths in the final message.**

The final message, printed after the `--- final message ---` line, is the only
reliable channel for the output path — the filename is generated and
version-dependent. One image takes minutes: exit 10 means Codex is still
working, so run `"${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" wait <dir>` until
the exit code changes. Exit 11 means an action stayed blocked: the envelope's
`blocked` list says which, and the `codex` skill's "Blocked actions" section
says how to rule on it.

**Then confirm the copy against this thread's own directory.** The envelope's
`thread_id` names it. List it newest first, then compare the first entry with
the destination:

```bash
ls -t ~/.codex/generated_images/<thread id>/
cmp -s ~/.codex/generated_images/<thread id>/<newest file> /absolute/path/to/destination.png \
  || cp ~/.codex/generated_images/<thread id>/<newest file> /absolute/path/to/destination.png
```

## Editing an existing image

Same invocation. Name the absolute source path(s) in the prompt and describe the
change; Codex inspects the file itself (`view_image`) before editing. **Never
describe the source image from memory** — you have not seen it, and a
description substituted for the real file produces a new image rather than an
edit. The source file is not modified; the result is a new image, so it needs
its own destination path.

Under `--json` the built-in tools emit no events, so the stream cannot tell you
whether Codex edited the file or generated a new one. `file` both images:
different dimensions hint at a regeneration; ask Codex when it matters.

## Iterating = resume, not a new run

"more blue", "drop the text", "same but wider" → resume the thread. It still
holds the previous image in context; a fresh run loses it and regenerates from
scratch. Resume replays the first turn's workspace root and write mode:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" resume <dir> --prompt-file <dir>/followup-2.md
```

The follow-up prompt is a full prompt: it needs **its own destination path and
the same two closing instructions**, otherwise the new image never leaves
`~/.codex/generated_images/`. Confirm it with the same thread-scoped check —
the thread dir accumulates, and `ls -t` lists the latest iteration first. The
`allowed-tools` grant covers the invoking turn only, so a follow-up in a later
turn may prompt.

## Pitfalls

- **`-C` outside a git repo** (scratch dir) → `codex exec` refuses to start;
  add `--skip-git-repo-check`.
- **`cp` overwrites the destination silently** — check before reusing a name.
- **Leave `~/.codex/generated_images/` alone.** The originals stay there by
  design; deleting them is not cleanup.
