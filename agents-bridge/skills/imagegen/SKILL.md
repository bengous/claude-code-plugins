---
name: imagegen
description: Generate or edit images with the Codex CLI's built-in image_gen tool. Use when the user asks to create, generate or draw an image, icon, logo, favicon, illustration or mockup, or to edit an existing image file — restyle, retouch, upscale, add or remove elements.
argument-hint: "<image to generate or edit> [-> destination path]"
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
  - Write(*:*)
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

So before invoking, decide an **absolute** destination path. `$ARGUMENTS` may
name one after a `->` (`a fox -> ./art/fox.png`); otherwise default to a
filename in the cwd. Resolve any relative path the user wrote **against your own
cwd**, then pass it absolute — the prompt is read inside codex, where a bare
`./x.png` means something else. `-C` must point at a directory that **contains**
the resolved destination: it is the writable workspace root, and it is what
makes the copy legal. The sandbox does not govern the tool's own write, only the
copy into the project.

## Invocation

Same invariants as the `codex` skill: prompt never inlined, written with the
Write tool, read from stdin via `-`; `--json` + `-o`; thread id from
`thread.started`.

```bash
# 1. Write /tmp/imagegen-prompt.md  <- the image request + the two instructions
#    below. Strip any `-> destination` off $ARGUMENTS first: it is this skill's
#    routing syntax, not part of the image description.
#    Pick per-run filenames (prompt, .jsonl, .last) if runs may overlap.
# 2. Run it. Add --skip-git-repo-check when -C is not inside a git repo.
"${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec \
  -s workspace-write -C /absolute/path/to/project \
  --json -o /tmp/imagegen.last \
  - < /tmp/imagegen-prompt.md \
  > /tmp/imagegen.jsonl

tid="$(jq -r 'select(.type=="thread.started") | .thread_id // empty' \
        /tmp/imagegen.jsonl | head -n1)"
```

The prompt must end with two explicit instructions:

1. **Copy** the chosen image to the absolute destination path.
2. **Report the absolute paths in the final message.**

The final message (`/tmp/imagegen.last`) is the only reliable channel for the
output path — the filename is generated and version-dependent, and scraping the
JSONL for it is brittle.

**Then confirm the copy, scoped by `$tid`.** Codex finds its own output by
scanning *all* of `~/.codex/generated_images/` for the newest file, so a
concurrent run can win that race and get copied instead — silently, with a
success report. `$tid` names this thread's own directory, which settles it:

```bash
src="$(ls -t ~/.codex/generated_images/"${tid}"/* | head -n1)"
cmp -s "${src}" /absolute/path/to/destination.png \
  || cp "${src}" /absolute/path/to/destination.png
```

## Editing an existing image

Same invocation. Name the absolute source path(s) in the prompt and describe the
change; Codex inspects the file itself (`view_image`) before editing. **Never
describe the source image from memory** — you have not seen it, and a
description substituted for the real file produces a new image rather than an
edit. The source file is not modified; the result is a new image, so it needs
its own destination path.

Under `--json` the built-in tools emit no events, so the stream cannot tell you
whether Codex edited the file or quietly generated a new one. `file` both images
and compare: an edit keeps the source's exact dimensions, a regeneration lands
on a standard size.

## Iterating = resume, not a new run

"more blue", "drop the text", "same but wider" → `exec resume "$tid"`. The
thread still holds the previous image in context; a fresh run loses it and
regenerates from scratch.

`resume` inherits nothing and has **neither `-s` nor `-C`** — `-C` is an `exec`
flag and resume errors out on it. Its writable root comes from the **process
cwd**, so `cd` into the destination directory first; skip that and
`workspace-write` is rooted wherever you happen to be, putting the destination
outside the writable root — the copy then fails while the run still reports
success.

```bash
cd /absolute/path/to/project && \
"${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec resume "${tid}" \
  -c sandbox_mode=workspace-write \
  --json -o /tmp/imagegen-2.last \
  - < /tmp/imagegen-followup.md \
  > /tmp/imagegen-2.jsonl
```

Add `--skip-git-repo-check` here too when that directory is not a git repo.
Use fresh `.last`/`.jsonl` names — reusing the first run's overwrites the only
record of it. The follow-up prompt is a full prompt: it needs **its own
destination path and the same two closing instructions**, otherwise the new
image never leaves `~/.codex/generated_images/`. Confirm it with the same
`$tid`-scoped check — the thread dir accumulates, and `ls -t` picks the latest
iteration.

## Pitfalls

- **Slow.** One image takes minutes; several exceed Bash's 10-minute default →
  set an explicit timeout or run in the background and poll.
- **`-C` outside a git repo** (scratch dir) → `codex exec` refuses to start;
  add `--skip-git-repo-check`.
- **`cp` overwrites the destination silently** — check before reusing a name.
- **Leave `~/.codex/generated_images/` alone.** The originals stay there by
  design; deleting them is not cleanup.
