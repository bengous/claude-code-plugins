/** Best effort: the URL is also logged in the session, for a host with no opener or no display. */
export function openInBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";

  try {
    Bun.spawn([opener, url], { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
  } catch (cause) {
    console.error(`vellum: could not open the browser with ${opener}: ${String(cause)}`);
  }
}
