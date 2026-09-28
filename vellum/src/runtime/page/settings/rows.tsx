import type { ComponentChildren, JSX } from "preact";

/** What a section is made of: a titled block of rows. */
export function SettingsGroup(props: {
  readonly title: string;
  readonly children: ComponentChildren;
}): JSX.Element {
  return (
    <div class="settings-group">
      <h4>{props.title}</h4>
      <div class="settings-rows">{props.children}</div>
    </div>
  );
}

/** One setting: its label and what it does on the left, its control or its value on the right. */
export function SettingsRow(props: {
  readonly label: string;
  readonly description?: string;
  readonly children: ComponentChildren;
}): JSX.Element {
  return (
    <div class="srow">
      <div>
        <div class="srow-label">{props.label}</div>
        {props.description !== undefined && <div class="srow-desc">{props.description}</div>}
      </div>
      <div class="srow-control">{props.children}</div>
    </div>
  );
}
