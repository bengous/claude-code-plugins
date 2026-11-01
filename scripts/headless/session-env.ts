/**
 * The identity a Claude Code session hands its children, as a hook's environment lists it. A
 * `claude` this repository's tooling starts is no child of the session that runs the tooling, and
 * would otherwise take itself for a nested one. Everything else goes along, the user's own
 * CLAUDE_* settings and login included.
 */
const SESSION_IDENTITY: ReadonlySet<string> = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CLAUDE_PROJECT_DIR",
]);

export function withoutSessionIdentity(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SESSION_IDENTITY.has(name)));
}
