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

/** Best effort: the session prints the address too, for a host with no opener or no display. */
export function openInBrowser(url: string): void {
  const opener = openerOf(process.platform);

  try {
    Bun.spawn([...opener, url], { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
  } catch (cause) {
    console.error(`pinpoint: could not open the browser with ${opener[0]}: ${String(cause)}`);
  }
}
