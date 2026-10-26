# wrap-archive

A mod for Claude Code Desktop that offers to archive a session once its task looks finished, so the sidebar holds only work in progress.

## What it does

When a turn you prompted (from the app or a device connected through Remote Control) ends with an answer, a small model reads your prompt and the answer, each cut to 4,000 characters, and judges the task `done` or `not_done`. A question to you, a plan awaiting approval and a proposed follow-up count as not done. When it judges the task done, a band above the prompt asks:

```
Task finished?  [ Archive ]  [ Keep ]
```

- **Archive** archives the session through the app's own `archive_session` tool. It stays reversible from the sidebar's Archived list.
- **Keep** hides the band until you send your next prompt. A task notification, a scheduled run or another plugin's prompt does not bring it back.
- Sending a new prompt withdraws the band, and drops a judgment still running.

Nothing is archived without a click on the band. The judgment, the band and your answer stay out of the session's context: the working model never sees them. The judge runs after the turn has ended, so it never delays a turn; it uses Haiku at low effort with a 20-second limit.

A judge or archive failure shows as one status line, cleared at your next prompt. In a session the app's archive tool cannot reach (a terminal session, for one), the mod does nothing.

## Install

```
/plugin install wrap-archive@bengous-plugins
```

Turn it off by disabling the plugin.
