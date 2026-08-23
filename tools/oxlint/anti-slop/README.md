# anti-slop (vendored)

Oxlint plugin copied from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), MIT.

- Upstream commit: `6d538555cb151d4121ed51a27db81890eacf8ae9` (2026-08-18)
- Source path: `skills/install-anti-slop/assets/anti-slop/`
- Copied with: `node <clone>/skills/install-anti-slop/scripts/install.mjs`

The optional `effect/` sub-plugin is not vendored: this repo declares no `effect`
dependency. Re-run the installer to pull it in if that changes.

Do not edit these files. `oxlint.config.ts` ignores this directory and registers
`index.ts` as a JS plugin. `LICENSE` is upstream text as well; this `README.md`
is the one repo-owned file here, which is why the manifest below skips it.

`../CHECKSUMS.sha256` freezes every other file in this directory, and
`scripts/check-lint-config.ts` refuses a commit that edits one, or that adds a
file the manifest never listed. To bump the pack, in a single commit:

1. Re-run the installer against the new upstream commit.
2. Refresh `LICENSE` from that same commit.
3. Regenerate the manifest from the upstream tree, never from the local files —
   deriving it from what is on disk would sign whatever an edit left there:

   ```bash
   cd tools/oxlint && git ls-files anti-slop \
     | grep -v '^anti-slop/README.md$' | xargs sha256sum > CHECKSUMS.sha256
   ```

   That command is only sound once step 1 has proved the local tree equals
   upstream, file for file.
4. Bump the commit SHA recorded above.
