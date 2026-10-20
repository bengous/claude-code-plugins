/**
 * Whether a failed git, gh or bun call failed on the network or on GitHub rather than on the request, so the same
 * call may pass later. Measured on 2026-10-20: gh 2.102.0 prints "error connecting to <host>" and "dial tcp …:
 * connect: connection refused"; git 2.56.0 "Failed to connect to …: Could not connect to server", "Could not resolve
 * host: …" and, over ssh, "connect to host … port …: Connection refused"; bun 1.4.3 "ConnectionRefused downloading
 * package manifest". The other phrases are Go's, curl's and GitHub's wording, not measured. Anything else, a refused
 * key, a bad remote, a lock git could not take, a 4xx, is the request's: permanent.
 */
const TRANSIENT = new RegExp(
  [
    "error connecting to",
    "could not connect to server",
    "failed to connect to",
    "connection ?(?:refused|reset|closed|timed out)",
    "operation timed out",
    "could not resolve host",
    "no such host",
    "temporary failure in name resolution",
    "network is unreachable",
    String.raw`i/o timeout`,
    "tls handshake timeout",
    "unexpected eof",
    "ssl_error_syscall",
    String.raw`HTTP 5\d\d`,
    "HTTP 429",
    String.raw`returned error: (?:5\d\d|429)`,
    "rate limit",
    "something went wrong while executing your query",
    String.raw`client\.timeout exceeded`,
    "context deadline exceeded",
  ].join("|"),
  "iu",
);

export function isTransient(output: string): boolean {
  return TRANSIENT.test(output);
}

/** A failure on the network or on GitHub, as `isTransient` read the call's output: a later run may pass. */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}
