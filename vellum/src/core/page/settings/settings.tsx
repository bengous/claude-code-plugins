import type { JSX } from "preact";
import { useState } from "preact/hooks";

import { Button, Dialog } from "../kit.tsx";
import type { SettingsSection } from "./sections.ts";
import { SETTINGS } from "./sections.ts";

/** The list as drawn: the headed groups first, then the sections under no heading. */
type SettingsNav = {
  readonly groups: readonly {
    readonly title: string;
    readonly sections: readonly SettingsSection[];
  }[];
  readonly pinned: readonly SettingsSection[];
};

/** The headings in their first order of appearance, each with its sections. */
function navOf(sections: readonly SettingsSection[]): SettingsNav {
  const titles = [...new Set(sections.flatMap((section) => section.group ?? []))];

  return {
    groups: titles.map((title) => ({
      title,
      sections: sections.filter((section) => section.group === title),
    })),
    pinned: sections.filter((section) => section.group === null),
  };
}

/** The settings, a modal: the sections listed on the left, the one open on the right. */
export function Settings(props: { readonly onClose: () => void }): JSX.Element {
  const [openId, setOpenId] = useState(SETTINGS[0]?.id);
  const open = SETTINGS.find((section) => section.id === openId);
  const { groups, pinned } = navOf(SETTINGS);

  const entry = (section: SettingsSection): JSX.Element => (
    <button
      type="button"
      key={section.id}
      aria-current={section.id === openId ? "page" : undefined}
      onClick={() => setOpenId(section.id)}
    >
      {section.label}
    </button>
  );

  return (
    <Dialog label="Settings" class="settings" onCancel={props.onClose}>
      <div class="settings-head">
        <h2>Settings</h2>
        <Button size="sm" onClick={props.onClose}>
          Close
        </Button>
      </div>
      <div class="settings-body">
        <nav class="settings-nav" aria-label="Settings sections">
          {groups.map((group) => (
            <div key={group.title}>
              <h3>{group.title}</h3>
              {group.sections.map((section) => entry(section))}
            </div>
          ))}
          {groups.length > 0 && pinned.length > 0 && <hr />}
          {pinned.map((section) => entry(section))}
        </nav>
        {open !== undefined && (
          <section class="settings-panel" aria-labelledby={`settings-${open.id}`}>
            <h3 id={`settings-${open.id}`}>{open.label}</h3>
            <open.Body />
          </section>
        )}
      </div>
    </Dialog>
  );
}
