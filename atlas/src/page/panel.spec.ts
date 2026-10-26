import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { DEEP } from "../../fixtures/trees.ts";
import type { AtlasMap } from "../model/atlas.ts";
import { loadFolder } from "../model/folder.ts";
import type { Place } from "../model/navigation.ts";
import type { Settings } from "../model/settings.ts";
import { settingsOf } from "../model/settings.ts";
import { treeOf } from "../model/tree.ts";
import { WORDS } from "../model/words.ts";
import { renderCrumbs, renderPanel } from "./panel.ts";
import { esc } from "./svg.ts";

const SAMPLE = join(import.meta.dir, "..", "..", "fixtures", "sample");

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

  test("markup a panel does not keep, in any field a map writes, is shown as text and runs nothing", async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

    const map: AtlasMap = {
      root: { title: `Map${hostile}`, lead: hostile, children: [] },
      links: [],
    };

    const node = {
      id: "a",
      label: `A${hostile}`,
      sub: "",
      color: "clients",
      lead: `<code>kept</code> ${hostile}`,
      io: [["Receives", hostile]],
      swap: hostile,
      extend: hostile,
      pitfalls: [hostile],
      why: [hostile],
      alt: hostile,
      how: hostile,
      seams: [["a", hostile]],
      traps: [["a", hostile]],
      open: [{ id: "o", text: hostile }],
    } as const;

    const tree = treeOf({ ...map, root: { ...map.root, children: [node] } });
    const settings = settingsOf(CONFIG);
    const threads = { kind: "ok", threads: {} } as const;

    for (const place of [
      { path: [], selected: null },
      { path: [], selected: "a" },
    ]) {
      const panel = { innerHTML: "", scrollTop: 0 };
      renderPanel(settings, tree, panel, place, null, threads);

      expect(await elementsWith(panel.innerHTML, "img, script")).toBe(0);
      expect(panel.innerHTML).toContain("&lt;img src=x onerror=");
    }

    const panel = { innerHTML: "", scrollTop: 0 };
    renderPanel(settings, tree, panel, { path: [], selected: "a" }, null, threads);

    expect(panel.innerHTML).toContain("<code>kept</code>");
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

describe("the panel's headings", () => {
  const ORDERS = { path: ["server", "app"], selected: "orders" };
  const threads = { kind: "ok", threads: {} } as const;

  const rendered = (settings: Settings, tree = TREE, place: Place = ORDERS): string => {
    const panel = { innerHTML: "", scrollTop: 0 };
    renderPanel(settings, tree, panel, place, null, threads);

    return panel.innerHTML;
  };

  test("a map that names two headings shows them, and the dictionary's for the others", () => {
    const html = rendered(
      settingsOf({ ...CONFIG, headings: { io: "Terrain", pitfalls: "Jamais" } }),
    );

    expect(html).toContain("<h3>Terrain</h3>");
    expect(html).toContain("<h3>Jamais</h3>");
    expect(html).not.toContain(`<h3>${WORDS.fr.headings.io}</h3>`);
    expect(html).not.toContain(`<h3>${WORDS.fr.headings.pitfalls}</h3>`);
    expect(html).toContain(`<h3>${WORDS.fr.headings.swap}</h3>`);
    expect(html).toContain(`<h3>${esc(WORDS.fr.headings.alt)}</h3>`);
  });

  test("a map that names none shows the dictionary's", () => {
    const html = rendered(settingsOf(CONFIG));

    expect(html).toContain(`<h3>${WORDS.fr.headings.io}</h3>`);
    expect(html).toContain(`<h3>${WORDS.fr.headings.swap}</h3>`);
    expect(html).toContain(`<p class="label">${esc(WORDS.fr.headings.coupledWith)}</p>`);
    expect(html).toContain(`<h3>${WORDS.fr.headings.pitfalls}</h3>`);
  });

  test("every section reads its heading from the settings", () => {
    const node = {
      id: "a",
      label: "A",
      sub: "",
      color: "clients",
      io: [["Receives", "x"]],
      swap: "x",
      couples: ["b"],
      extend: "x",
      pitfalls: ["x"],
      seams: [["b", "x"]],
      traps: [["b", "x"]],
      why: ["x"],
      alt: "x",
      facts: [["k", "v"]],
      how: "x",
      see: ["b"],
    } as const;

    const other = { id: "b", label: "B", sub: "", color: "clients" };
    const tree = treeOf({ root: { title: "T", children: [node, other] }, links: [] });
    const keys = Object.keys(WORDS.fr.headings);
    const headings = Object.fromEntries(keys.map((key) => [key, `named ${key}`]));
    const html = rendered(settingsOf({ ...CONFIG, headings }), tree, { path: [], selected: "a" });

    expect(keys).toHaveLength(12);

    for (const key of keys) {
      expect(html).toContain(`named ${key}`);
    }

    for (const word of Object.values(WORDS.fr.headings)) {
      expect(html).not.toContain(`>${esc(word)}<`);
    }
  });

  test("a heading holding markup shows as text and runs nothing", async () => {
    const html = rendered(
      settingsOf({ ...CONFIG, headings: { io: "<b>x</b>", coupledWith: "<img src=x>" } }),
    );

    expect(await elementsWith(html, "h3 b, img")).toBe(0);
    expect(html).toContain("<h3>&lt;b&gt;x&lt;/b&gt;</h3>");
    expect(html).toContain('<p class="label">&lt;img src=x&gt;</p>');
  });
});

describe("the breadcrumb", () => {
  test("five levels down, the middle levels fold into one that names them in its tooltip", () => {
    const crumbs = { innerHTML: "" };
    const place = { path: ["B", "B1", "B11", "B111"], selected: "b1" };

    renderCrumbs(settingsOf(CONFIG), treeOf(DEEP), crumbs, place);

    expect(crumbs.innerHTML).toBe(
      '<button type="button" data-go="" title="Bookshop">Bookshop</button>' +
        '<span class="sep">›</span><span class="fold" title="B › B1 › B11">…</span>' +
        '<span class="sep">›</span><button type="button" data-go="B111" title="B111">B111</button>' +
        '<span class="sep">›</span><button type="button" data-go="b1" title="b1" aria-current="true">b1</button>',
    );
  });

  test("three levels down, every crumb shows, the open container current", () => {
    const crumbs = { innerHTML: "" };

    renderCrumbs(settingsOf(CONFIG), TREE, crumbs, { path: ["server", "app"], selected: null });

    expect(crumbs.innerHTML).not.toContain("fold");
    expect(crumbs.innerHTML).toContain(
      '<button type="button" data-go="app" title="Application" aria-current="true">Application</button>',
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
