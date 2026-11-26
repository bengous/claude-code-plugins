A user who wants the plan of a past session has to find its transcript by hand among hundreds of files.

**Done when** `sessions find` answers with the session that wrote a plan. What the command prints and its exit codes are the contract; the index and its storage are free.

```console
$ sessions find "migrate the importer"
3f2a91c  2026-11-20  ~/Work/genealogy  "Plan: migrate the importer to streams"
$ sessions find "nothing like this"
no session wrote a plan matching "nothing like this"
$ echo $?
1
```

| Situation | Expected |
|---|---|
| a phrase from one plan | that session, its date and its folder |
| a phrase from no plan | the message above, exit 1 |
| `sessions list`, as today | unchanged output: no regression |

**Not this** plans of other users, a search inside transcripts.

<details><summary>Author's leads</summary>

- Plans are stored under `~/.claude/plans/by-session/<session_id>.md`.

</details>

<sub>Written by Claude Opus 5.5</sub>
