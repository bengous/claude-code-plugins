import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { loadFolder, planOf } from "./folder.ts";
import { graphOf } from "./graph.ts";
import { renderPanel } from "./panel.ts";
import { settingsOf } from "./settings.ts";
import { esc } from "./svg.ts";

const SAMPLE = join(import.meta.dir, "fixtures", "sample");

const GRAPH = graphOf(await planOf(SAMPLE));

const { config: CONFIG } = await loadFolder(SAMPLE);

describe("the panel's HTML", () => {
  test("esc makes a value safe in a text node and in a quoted attribute", () => {
    expect(esc(`a"b'c<d>&e`)).toBe("a&quot;b&#39;c&lt;d&gt;&amp;e");
  });

  test("a human name with quotes stays inside the reply input's placeholder", async () => {
    const panel = { innerHTML: "", scrollTop: 0 };
    const settings = settingsOf({ ...CONFIG, human: 'Jean "JJ" x" data-injected="yes' });
    const place = { zone: null, node: "backup" };

    renderPanel(settings, GRAPH, panel, place, null, { kind: "ok", threads: {} });

    expect(await elementsWith(panel.innerHTML, "[data-injected]")).toBe(0);
    expect(panel.innerHTML).toContain(
      'placeholder="Répondre (Jean &quot;JJ&quot; x&quot; data-injected=&quot;yes)"',
    );
  });
});

// The elements an HTML parser finds for a selector in a fragment.
async function elementsWith(html: string, selector: string): Promise<number> {
  let found = 0;

  await new HTMLRewriter()
    .on(selector, {
      element() {
        found += 1;
      },
    })
    .transform(new Response(html))
    .text();

  return found;
}
