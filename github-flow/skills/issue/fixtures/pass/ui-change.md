The settings pane hides the save button below the fold on a laptop screen, so changes are lost when the pane closes.

**Done when** the save button stays in view at every height. Where the button sits and when it is enabled are the contract; its style is free.

```text
 1280×720, scrolled to the top        1280×720, scrolled to the bottom
┌──────────────────────────────┐      ┌──────────────────────────────┐
│ Settings                     │      │ … Advanced                   │
│ ☐ Dark theme                 │      │ ☐ Telemetry                  │
│ ☐ Compact rows               │      │ ☐ Beta features              │
├──────────────────────────────┤      ├──────────────────────────────┤
│              [ Save ] (dim)  │      │              [ Save ]        │
└──────────────────────────────┘      └──────────────────────────────┘
```

| Situation | Expected |
|---|---|
| 1280×720, no change made | the button in view, disabled |
| 1280×720, one box ticked | the button in view, enabled |
| 1920×1080, as today | the button where it is now: no regression |

**Not this** the layout of the boxes, the mobile view.

<details><summary>Author's leads</summary>

- The pane is a fixed-height dialog; the button sits after the last section.

</details>

<sub>Written by Claude Opus 5.5</sub>
