import { describe, expect, test } from "bun:test";

import { isTransient } from "./transient.ts";

describe("isTransient", () => {
  test.each([
    "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com",
    'Get "https://api.github.com/rate_limit": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused',
    "fatal: unable to access 'http://127.0.0.1:9/x.git/': Failed to connect to 127.0.0.1:9 after 0 ms: Could not connect to server",
    "fatal: unable to access 'https://nonexistent.invalid/x.git/': Could not resolve host: nonexistent.invalid",
    "ssh: connect to host 127.0.0.1 port 9: Connection refused\nfatal: Could not read from remote repository.",
    "error: ConnectionRefused downloading package manifest is-number",
    "gh: Server Error (HTTP 502)",
    "gh: API rate limit exceeded for user ID 1. (HTTP 403)",
    "GraphQL: Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug.",
    'Post "https://api.github.com/graphql": net/http: request canceled (Client.Timeout exceeded while awaiting headers)',
    "context deadline exceeded",
  ])("reads a network or GitHub failure as transient: %s", (output) => {
    expect(isTransient(output)).toBe(true);
  });

  test.each([
    "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    "fatal: '/nonexistent/gone.git' does not appear to be a git repository",
    "error: cannot lock ref 'refs/remotes/origin/dev': is at 1234 but expected 5678",
    "gh: No commit found for SHA: 0000 (HTTP 422)",
    'no pull requests found for branch "no-such-branch-xyz"',
    "GraphQL: Your token has not been granted the required scopes",
  ])("reads a failure of the request itself as permanent: %s", (output) => {
    expect(isTransient(output)).toBe(false);
  });
});
