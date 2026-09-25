import type { PageExtension } from "../core/extension.ts";
import { grillPage } from "./grill/page.tsx";
import { htmlPage } from "./html/page.tsx";
import { imagePage } from "./image/page.tsx";
import { markdownPage } from "./markdown/page.tsx";
import { reviewPage } from "./review/page.tsx";
import { stepPage } from "./step/page.tsx";

/** Every page extension, in match order: a `grill-<n>.md` is Markdown too, so `grill` comes first. */
export const pageExtensions: readonly PageExtension[] = [
  grillPage,
  reviewPage,
  stepPage,
  markdownPage,
  htmlPage,
  imagePage,
];
