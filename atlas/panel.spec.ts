import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { loadFolder } from "./folder.ts";
import { renderPanel } from "./panel.ts";
import { settingsOf } from "./settings.ts";
import { esc } from "./svg.ts";
import { treeOf } from "./tree.ts";

const SAMPLE = join(import.meta.dir, "fixtures", "sample");

const { map: MAP, config: CONFIG } = await loadFolder(SAMPLE);

const TREE = treeOf(MAP);

describe("the panel's HTML", () => {
  test("esc makes a value safe in a text node and in a quoted attribute", () => {
    expect(esc(`a"b'c<d>&e`)).toBe("a&quot;b&#39;c&lt;d&gt;&amp;e");
  });

  test("a human name with quotes stays inside the reply input's placeholder", async () => {
    const panel = { innerHTML: "", scrollTop: 0 };
    const settings = settingsOf({ ...CONFIG, human: 'Jean "JJ" x" data-injected="yes' });
    const place = { path: ["server", "data"], selected: "backup" };

    renderPanel(settings, TREE, panel, place, null, { kind: "ok", threads: {} });

    expect(await elementsWith(panel.innerHTML, "[data-injected]")).toBe(0);
    expect(panel.innerHTML).toContain(
      'placeholder="Répondre (Jean &quot;JJ&quot; x&quot; data-injected=&quot;yes)"',
    );
  });

  test("a selected node shows its fields, its couplings and the way up", () => {
    const panel = { innerHTML: "", scrollTop: 0 };
    const place = { path: ["server", "app"], selected: "orders" };

    renderPanel(settingsOf(CONFIG), TREE, panel, place, null, { kind: "ok", threads: {} });

    expect(panel.innerHTML).toContain('<h2><span class="swatch"></span>Orders</h2>');
    expect(panel.innerHTML).toContain('data-go="db"');
    expect(panel.innerHTML).toContain('data-go="email"');
    expect(panel.innerHTML).toContain('data-go="app">↑ Application');
  });

  test("an open container shows its brief, the tour's neighbours and the arrows' failure", () => {
    const panel = { innerHTML: "", scrollTop: 0 };
    const place = { path: ["server", "app"], selected: null };

    renderPanel(settingsOf(CONFIG), TREE, panel, place, "no wasm", { kind: "ok", threads: {} });

    expect(panel.innerHTML).toContain('<ul class="brief"><li>pages and routes</li>');
    expect(panel.innerHTML).toContain('data-go="server">← Server');
    expect(panel.innerHTML).toContain('data-go="data">Storage →');
    expect(panel.innerHTML).toContain("no wasm");
  });

  test("the root's view shows the root's fields, the tour and the arrows' failure", () => {
    const panel = { innerHTML: "", scrollTop: 0 };
    const place = { path: [], selected: null };

    renderPanel(settingsOf(CONFIG), TREE, panel, place, "no wasm", { kind: "ok", threads: {} });

    expect(panel.innerHTML).toContain('<h2><span class="swatch"></span>Bookshop</h2>');
    expect(panel.innerHTML).toContain('data-go="clients"');
    expect(panel.innerHTML).toContain("no wasm");
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
