/**
 * The command that opens a URL in the desktop's browser. Windows has no opener on the `PATH`
 * but `start`, a built-in of `cmd.exe` that reads `&` in a URL as its own; `rundll32` hands the
 * URL to the protocol handler with no shell in between.
 */
function openerOf(platform: NodeJS.Platform): readonly string[] {
  if (platform === "darwin") return ["open"];

  if (platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler"];

  return ["xdg-open"];
}

/** Best effort: the URL is also logged in the session, for a host with no opener or no display. */
export function openInBrowser(url: string): void {
  // `bun test` starts the real server on port 0; without this every run opens a tab.
  if (process.env.NODE_ENV === "test") return;
  const opener = openerOf(process.platform);

  try {
    Bun.spawn([...opener, url], { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
  } catch (cause) {
    console.error(`vellum: could not open the browser with ${opener[0]}: ${String(cause)}`);
  }
}
