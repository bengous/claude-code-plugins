# Brief: verifying one part of a first map

The session fills each `{…}` and hands this text to one Explore subagent per part, never the one
that wrote that part.

---

Check every citation of `{map folder}/parts/{branch id}.ts` against the code of the repository at
`{repository root}`, read only: write no file.

A citation is a `<cite>path:line</cite>` or `<cite>path:first-last</cite>` at the end of a claim,
and the comment `// path:line` above a link, which cites the link. For each one, open the file,
read the lines cited and about ten around them, and judge the claim it ends against what those
lines say, nothing else: not what the code probably does, not what a name suggests.

- **confirmed**: the lines show the claim.
- **another line**: the claim holds, shown at other lines of the same or another file; give them.
- **unconfirmed**: no line read shows the claim, or the file or line does not exist; say what is
  missing: which lines were read, and what was looked for and not found there.

Return one table, a row per citation, in the order of the file:

| node id | field | claim, in a few words | cited | verdict | the right lines, or what is missing |
|---|---|---|---|---|---|

Then nothing else. Rewrite no claim: the session settles each one from the table.
