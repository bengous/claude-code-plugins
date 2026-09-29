import { htmlPage } from "../../formats/html/page.tsx";
import { imagePage } from "../../formats/image/page.tsx";
import { markdownPage } from "../../formats/markdown/page.tsx";
import { reviewPage } from "../../steps/agent-review/page.tsx";
import { page as grillPage } from "../../steps/grill/page.tsx";
import { page as stepPage } from "../../steps/proposal/page.tsx";
import type { PageExtension } from "../extension.ts";

/** Every page extension, in match order: a `grill-<n>.md` is Markdown too, so `grill` comes first. */
export const pageExtensions: readonly PageExtension[] = [
  grillPage,
  reviewPage,
  stepPage,
  markdownPage,
  htmlPage,
  imagePage,
];
