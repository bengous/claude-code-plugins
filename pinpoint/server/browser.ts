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

/**
 * Hands `url` to the desktop's opener, detached: `null` once it runs, else why it could not, as
 * an opener missing from the `PATH`. The opener running promises no tab, a host with no display
 * having none to show.
 */
export function openInBrowser(url: string): string | null {
  const opener = openerOf(process.platform);

  try {
    Bun.spawn([...opener, url], { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();

    return null;
  } catch (cause) {
    return `could not run ${opener[0]}: ${String(cause)}`;
  }
}
