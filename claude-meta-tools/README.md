# Claude Meta-Tools Plugin

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

Write the prompt another Claude will act on, from a rough request or the preceding
conversation, carrying the user's intent at the user's level of certainty. Decisions and
ruled-out options travel with their reasons, open points stay open for the reader to raise,
references are verified against the repo and pointed to rather than copied, and nothing the
reader loads by itself is repeated. The prompt is prose in the order the reader uses it,
with no field labels. For the user to paste, it is the user's own first-person message and
the whole response; for a subagent, it is the input of the Agent call.

```bash
/meta-prompt add rate limiting to the API gateway
/meta-prompt            # no arguments: hand off the task discussed in this session
```

### `/ambition`

Show higher, deeper or wider versions of a request before it is briefed or started, along
the three directions of Felix Rieseberg's
[How to be more ambitious](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/):
altitude (the goal beyond the goal), depth (the method a field-leading expert would use) and
range (a field that already solved the hard part). Each version names what it would take,
marked present, missing or unverified, what would check it outside the model, and a first
step. It recommends the version with an outside check whose missing pieces the user can
supply, and changes nothing: the user picks, and `/meta-prompt` briefs the pick. User-invoked
only, since it widens scope on purpose.

```bash
/ambition add an index to the orders query
/ambition               # no arguments: the task discussed in this session
```

## License

Apache-2.0

## Author

Augustin BENGOLEA <bengous@protonmail.com>
