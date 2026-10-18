/**
 * The app a person names, as `/pinpoint:start <url>`, the "Which app?" field or `cli.ts serve
 * --target` read it: an `http:` or `https:` URL. A bare port is an app on this machine, and an
 * address with no scheme is taken as `http:`, as a dev server prints it. A URL a paste broke over
 * lines is joined again.
 */
export function targetOf(text: string): URL | null {
  const typed = text.trim().replaceAll(/\s*\n\s*/gu, "");
  const spelled = /^\d+$/u.test(typed) ? `localhost:${typed}` : typed;
  const url = URL.parse(/^[a-z][a-z\d+.-]*:\/\//iu.test(spelled) ? spelled : `http://${spelled}`);

  return url !== null &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname !== ""
    ? url
    : null;
}

/** The session's address on `port`: the app's path once one is served, "Which app?" with none. */
export function addressOn(port: number, target: URL | null): string {
  return `http://localhost:${port}${target === null ? "/" : `${target.pathname}${target.search}`}`;
}
