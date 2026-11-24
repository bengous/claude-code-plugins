# Video

A clip proves a transition: an animation, a navigation, a sequence of gestures. Two stills prove a
state. Record only what a pair of images cannot show.

## The recipe

A standalone script. It drives Playwright directly, so it needs no `testMatch`, no
`playwright.config.ts`, no fixture, and it writes nothing inside the repo. Keep it in the
scratchpad and delete it after.

```ts
// Resolve Playwright from the package that depends on it. A script living outside the repo
// resolves from its own directory upward and picks whatever global copy the package manager
// cached, whose browsers are usually absent. In a monorepo PKG is the app, not the root.
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.PKG}/package.json`);
const { chromium, devices } = require(require.resolve('playwright', { paths: [process.env.PKG] }));

const browser = await chromium.launch();
const context = await browser.newContext({
    ...devices['Pixel 5'], // the descriptor carries viewport, hasTouch, isMobile and the UA
    recordVideo: { dir: process.env.OUT, size: { width: 393, height: 830 } },
});
const page = await context.newPage();

await page.goto(process.env.URL);
const target = page.locator('dialog#example');
await target.waitFor({ state: 'visible', timeout: 15000 });
await page.waitForTimeout(2000); // hold, so the entrance is readable at playback speed
await target.locator('button.primary').click();
await page.waitForTimeout(2500);

await context.close(); // the video is only flushed here
await browser.close();
```

Run it against the repo's dev server, then rename the random `*.webm` the context wrote.

## Reusing a committed spec

Prefer the script. Reuse an existing spec only when one already exercises the exact scenario to
show: its selectors, waits and fixtures are debugged, and re-deriving them in a script risks
filming something else.

Playwright has no `--video` CLI flag, so the repo has to declare it once:

```ts
use: { video: process.env.PR_VIDEO ? 'on' : 'off' }
```

Then `PR_VIDEO=1 npx playwright test <spec>`. Read the spec before running it: a scenario that
takes an escape hatch (`?skip-animation`, a seeded storage state, a reduced-motion emulation)
films the flattened path, not the one the PR is about.

## Traps

| Trap | What happens | Fix |
|---|---|---|
| Module resolution | The global cache wins over the repo copy, and its browsers are not installed | Resolve from the repo, as above |
| `PKG` set to a monorepo root | `Cannot find package 'playwright'`: the dependency belongs to one workspace, not the root | Point it at the app that owns the dependency |
| `reducedMotion` in `use` | Playwright neither types nor forwards it, so the value never reaches the browser | `page.emulateMedia({ reducedMotion })` |
| A throwaway *spec* | Needs a `testMatch` entry, so it edits the repo config | Write a *script* instead |
| `agent-browser record` | Its `set device` leaves `pointer: coarse` false, so a UI gated on touch never appears | Playwright device descriptors |
| Video missing after the run | The file is written when the context closes | `await context.close()` before reading it |
| A subtle entrance | A 200ms fade reads as no animation at all once scaled down | Hold on the result, and say the duration in the body |

## Publishing

`gh pr create|edit --attach <path>` uploads to GitHub's own store and rewrites the matching
`![alt](<path>)` in the body. That is the only path that renders on a private repo: a
`raw.githubusercontent.com` URL 404s for the image proxy, which cannot authenticate. Needs
gh 2.99.0 or later.

GitHub accepts `.mp4`, `.mov` and `.webm`, so the webm Playwright writes can be attached as is.
Convert only to shrink it: `ffmpeg -i in.webm -vf scale=380:-2 -c:v libx264 -pix_fmt yuv420p
-movflags +faststart -crf 28 -an out.mp4`. Limits are 10 MB for images and 100 MB for video on a
paid plan, 10 MB on a free one.

Media files never enter the repo. `--attach` is their only path to GitHub.
