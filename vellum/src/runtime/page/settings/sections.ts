import type { ComponentType } from "preact";

import { AboutVellum } from "./about-vellum.tsx";

/** One entry of the settings' list, and the body it opens. */
export type SettingsSection = {
  readonly id: string;
  /** The list's entry and the panel's heading. */
  readonly label: string;
  /** The list's heading it sits under; `null` puts it after every group, under a rule. */
  readonly group: string | null;
  readonly Body: ComponentType;
};

/** Every section, in the list's order: a new setting is an entry here and a body. */
export const SETTINGS: readonly SettingsSection[] = [
  { id: "about-vellum", label: "About Vellum", group: null, Body: AboutVellum },
];
