Closes #455.

**Why** The panel's save toast vanished before a reader could read it, so a save looked like no save.

**Danger** two-way door · reach: every toast of the panel shares the timer, so a wrong value keeps them all on screen too long or too short.

**Start at** `toast.spec.ts`, the test `a save toast holds for 4 s`.

```diff
  showToast(message)
-   hide after 800 ms
+   hide after 4000 ms, or on a click
```

**Proof**

**Before**, the panel 900 ms after a save:

![The panel with no toast, 900 ms after a save](/tmp/pr-capture/before.png)

**After**, the same moment:

![The panel with the toast "Saved" at its foot](/tmp/pr-capture/after.png)

The toast enters, holds, then leaves on a click:

![](/tmp/pr-capture/after.mp4)

Protocol: build `a1b2c3d`, viewport 1440×900, page `/panel`, action edit then save.
The clip is asserted by `e2e/toast.spec.ts`, `a save toast holds for 4 s`.

<sub>Written by Claude</sub>
