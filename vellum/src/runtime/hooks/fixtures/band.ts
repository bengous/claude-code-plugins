import type { On } from "claude-code";
import type { Engine } from "claude-code/testing";

const ABOVE_PROMPT = {
  plugin: "vellum",
  surface: "terminal",
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const;

/** What the engine draws in the band when no plugin does: nothing of its own, so no text and no link. */
export function engineBand(on: On): void {
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Box } = $.ui.resolve(e);

    return Box({ key: "engine" });
  });
}

/** The band as last drawn: its whole text, and where its link goes. */
export type DrawnBand = {
  readonly text: () => Promise<string>;
  readonly href: () => Promise<string | undefined>;
};

/** The band above the prompt, mounted as the terminal shows it; `hasSurvey` when a survey holds it. */
export async function band($: Engine, hasSurvey = false): Promise<DrawnBand> {
  const ui = await $.ui.mount({ ...ABOVE_PROMPT, props: { ...ABOVE_PROMPT.props, hasSurvey } });

  return {
    text: async () => (await ui.find({ type: "Box" }))?.text ?? "",
    href: async () => {
      const link = await ui.find({ type: "Link" });

      return link === undefined ? undefined : String(link.props.href);
    },
  };
}
