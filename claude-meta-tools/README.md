# Claude Meta-Tools Plugin

v6.0.0

Meta tooling for Claude Code: write prompts that prompt better.

Since 5.0.0 this plugin is prompt-focused. Instruction-file maintenance moved to
[context-management](../context-management/), research and fact-checking to
[research-tools](../research-tools/), `/explain` and `/troubleshoot` to
[understanding](../understanding/). 6.0.0 narrowed it to `/meta-prompt`: `/explain-workflow`
moved to [understanding](../understanding/), `/prompt-health` is covered by the native
`/claude-api prompt-audit`, `/prompt-coach` and `/dump-system-prompt` were dropped (the npm
package ships a native binary since Claude Code 2.1.113, so there is no `cli.js` to parse).

## Skills

### `/meta-prompt`

Turn a rough request — or the preceding conversation — into a clean prompt for another
agent, carrying the user's intention at the user's level of certainty. Explicit directives
stay directives, open points stay open for the executor to ask, references are verified
against the repo and reported as facts. No plan, no model inference, no fence or rationale
around the output: the response is the prompt.

```bash
/meta-prompt add rate limiting to the API gateway
/meta-prompt            # no arguments: hand off the task discussed in this session
```

## License

Apache-2.0

## Author

Augustin BENGOLEA <bengous@protonmail.com>
