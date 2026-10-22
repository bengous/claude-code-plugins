// Hands a page's address to the desktop's browser, detached, for the hooks module, which knows no
// platform and whose children end with it:
//   bun atlas/src/server/open.ts <url>   exits 1 with the reason when no opener runs
export function openerOf(platform: NodeJS.Platform): string | null {
  if (platform === "darwin") {
    return "open";
  }

  return platform === "linux" ? "xdg-open" : null;
}

if (import.meta.main) {
  const [url, ...extra] = process.argv.slice(2);
  const opener = openerOf(process.platform);

  if (url === undefined || extra.length > 0) {
    console.error("usage: bun open.ts <url>");
    process.exit(1);
  }

  if (opener === null) {
    console.error(`open: no browser opener on ${process.platform}`);
    process.exit(1);
  }

  try {
    Bun.spawn([opener, url], { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
  } catch (error: unknown) {
    console.error(`open: could not run ${opener}: ${String(error)}`);
    process.exit(1);
  }
}
