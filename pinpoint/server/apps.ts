import { folderName } from "../shared/folder.ts";

/**
 * The "Which app?" page, served at `/` until an app is chosen: the apps running on this machine,
 * found by probing the usual dev servers' ports, and a field for any other address.
 */

/** Ports dev servers take by default: Next, Rails, Express, Astro, Angular, Vite, Storybook, Django… */
export const DEV_PORTS: readonly number[] = [
  3000, 3001, 3002, 3003, 3004, 3005, 4000, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5176, 5177,
  5178, 5179, 6006, 8000, 8080, 8081, 8888, 9000,
];

/** How long a port has to answer with its page: the "Which app?" page waits for the slowest. */
export const PROBE_MS = 1_000;

/**
 * An app a port holds: one that answered with a page, its `<title>` `""` for none, or one that
 * took the connection and had not answered within the probe's time, as a dev server compiling
 * its first page does.
 */
export type Found =
  | { readonly kind: "answered"; readonly url: string; readonly title: string }
  | { readonly kind: "waiting"; readonly url: string };

/** The text of the page's first `<title>`: a `<title>` of an inline SVG comes later, in the body. */
type TitleRead = { text: string; at: "before" | "inside" | "past" };

async function titleOf(page: Response): Promise<string> {
  const title: TitleRead = { text: "", at: "before" };

  const read = new HTMLRewriter().on("title", {
    element: (element) => {
      if (title.at !== "before") return;
      title.at = "inside";

      element.onEndTag(() => {
        title.at = "past";
      });
    },
    text: (chunk) => {
      if (title.at === "inside") title.text += chunk.text;
    },
  });

  const reader = read.transform(page).body?.getReader();

  if (reader === undefined) return "";

  try {
    // Read up to the title's end only: the rest of a page may take long to come.
    for (;;) {
      if (title.at === "past" || (await reader.read()).done) break;
    }
  } catch {
    // The probe's time ran out in the body: the title read so far stands.
  } finally {
    await reader.cancel().catch(() => {});
  }

  return title.text.trim();
}

async function probeOne(port: number, ms: number): Promise<Found | null> {
  const url = `http://localhost:${port}/`;
  let answer: Response;

  try {
    answer = await fetch(url, {
      headers: { accept: "text/html" },
      proxy: false,
      signal: AbortSignal.timeout(ms),
    });
  } catch (cause) {
    // A refused port fails at once; one that took the connection but stayed silent times out.
    return cause instanceof DOMException && cause.name === "TimeoutError"
      ? { kind: "waiting", url }
      : null;
  }

  if (!(answer.headers.get("content-type") ?? "").includes("text/html")) {
    await answer.body?.cancel();

    return null;
  }

  return { kind: "answered", url, title: await titleOf(answer) };
}

/** The apps answering HTML on `ports` at `localhost`, in the ports' order, `own` left out. */
export async function probe(
  ports: readonly number[],
  own: number,
  ms: number = PROBE_MS,
): Promise<Found[]> {
  const answers = await Promise.all(
    ports.flatMap((port) => (port === own ? [] : [probeOne(port, ms)])),
  );

  return answers.filter((found): found is Found => found !== null);
}

function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1d2430; --muted: #5b6575; --line: #d5dbe4; --accent: #2563eb; --bg: #ffffff; --card: #f5f7fa; --error: #b42318; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e9ef; --muted: #9aa3b2; --line: #2e3542; --accent: #7aa7ff; --bg: #12151b; --card: #1a1f28; --error: #ff8a80; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 34rem; margin: 3rem auto; padding: 0 16px; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
p { color: var(--muted); margin: 0 0 1.25rem; }
.error { color: var(--error); }
.session strong { color: var(--fg); overflow-wrap: anywhere; }
ul { list-style: none; padding: 0; margin: 0 0 2rem; display: grid; gap: .5rem; }
form { margin: 0; }
.app { width: 100%; text-align: left; padding: .75rem 1rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--card); color: inherit; font: inherit; cursor: pointer; }
.app:hover, .app:focus-visible { border-color: var(--accent); outline: none; }
.name { display: block; font-weight: 600; overflow-wrap: anywhere; }
.address { display: block; color: var(--muted); font-size: .875rem; }
label { display: block; font-weight: 600; margin-bottom: .375rem; }
.other { display: flex; gap: .5rem; }
.other input { flex: 1; min-width: 0; padding: .5rem .75rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--bg); color: inherit; font: inherit; }
.other button { padding: .5rem 1rem; border: 0; border-radius: .5rem; background: var(--accent); color: #fff; font: inherit; cursor: pointer; }
`;

/**
 * The page itself: the session `root` the batches will reach, one button per app found, each
 * posting its address to `/t/<token>/pick`, and the field posting there too. `error` says why the
 * last address was refused, `typed` what it was.
 */
export function pickPage(
  token: string,
  root: string,
  apps: readonly Found[],
  error: string | null,
  typed: string,
): string {
  const action = `/t/${token}/pick`;

  const listed = apps.map((app) => {
    const name = app.kind === "answered" && app.title !== "" ? app.title : new URL(app.url).host;

    const said =
      app.kind === "waiting" ? " · no answer within a second yet, maybe still starting" : "";

    return `<li><form method="post" action="${action}">
<input type="hidden" name="url" value="${escaped(app.url)}">
<button class="app" type="submit"><span class="name">${escaped(name)}</span><span class="address">${escaped(app.url)}${said}</span></button>
</form></li>`;
  });

  const found =
    listed.length === 0
      ? `<p>No app answers on the usual dev ports (${DEV_PORTS.join(", ")}).</p>`
      : `<ul>\n${listed.join("\n")}\n</ul>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Which app? · pinpoint</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Which app?</h1>
<p>Pick the app to point at. This address then serves it, with the pinpoint overlay.</p>
<p class="session" title="${escaped(root)}">Batches go to the Claude Code session in <strong>${escaped(folderName(root))}</strong>.</p>
${error === null ? "" : `<p class="error" role="alert">${escaped(error)}</p>\n`}${found}
<form method="post" action="${action}">
<label for="url">Another address</label>
<div class="other">
<input id="url" name="url" type="text" inputmode="url" placeholder="http://localhost:5173/" value="${escaped(typed)}" required>
<button type="submit">Open</button>
</div>
</form>
</main>
</body>
</html>
`;
}
