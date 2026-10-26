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
import type { Viewer } from "./panel.ts";
import { fieldHtml, linesAround, renderCrumbs, renderPanel, renderViewer } from "./panel.ts";
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

describe("the panel's citations", () => {
  const node = {
    id: "a",
    label: "A",
    sub: "",
    color: "clients",
    kicker: "src/a.ts:1-9 <cite>src/a.ts:1</cite>",
    lead: "Takes a cart <cite>src/a.ts:12-30</cite>, as <cite>the docs</cite> say.",
    io: [["Receives", "a cart <cite>src/web.ts:4</cite>"]],
    pitfalls: ["Slow <cite>src/b.ts:4,8-9</cite>."],
  } as const;

  const tree = treeOf({ root: { title: "T", children: [node] }, links: [] });
  const panel = { innerHTML: "", scrollTop: 0 };

  renderPanel(settingsOf(CONFIG), tree, panel, { path: [], selected: "a" }, null, {
    kind: "ok",
    threads: {},
  });

  test("a citation shows as a marker of its lines, the whole citation its tooltip", () => {
    expect(panel.innerHTML).toContain(
      'Takes a cart <cite class="cite" title="src/a.ts:12-30"><span class="cite-path">src/a.ts:</span>12-30</cite>,',
    );
    expect(panel.innerHTML).toContain(
      '<cite class="cite" title="src/web.ts:4"><span class="cite-path">src/web.ts:</span>4</cite>',
    );
    expect(panel.innerHTML).toContain(
      '<cite class="cite" title="src/b.ts:4,8-9"><span class="cite-path">src/b.ts:</span>4,8-9</cite>',
    );
  });

  test("a <cite> of any other text shows as written", () => {
    expect(panel.innerHTML).toContain("as <cite>the docs</cite> say");
  });

  test("a kicker stays escaped text, a citation in it included", () => {
    expect(panel.innerHTML).toContain(
      '<p class="kicker">src/a.ts:1-9 &lt;cite&gt;src/a.ts:1&lt;/cite&gt;</p>',
    );
  });

  test("fieldHtml, which every HTML field goes through, keeps the panel's markup and its markers", () => {
    expect(fieldHtml(settingsOf(CONFIG), '<b>x</b> <cite>a.ts:1</cite> <img src="y">')).toBe(
      '<b>x</b> <cite class="cite" title="a.ts:1"><span class="cite-path">a.ts:</span>1</cite> &lt;img src="y">',
    );
  });

  test("without a sources root, no marker is a button", () => {
    expect(panel.innerHTML).not.toContain("data-cite");
    expect(panel.innerHTML).not.toContain('<button type="button" class="cite-open"');
  });

  test("with a sources root, each marker is a button that names its citation", () => {
    const sourced = { innerHTML: "", scrollTop: 0 };
    const settings = settingsOf({ ...CONFIG, sources: { root: "repo" } });

    renderPanel(settings, tree, sourced, { path: [], selected: "a" }, null, {
      kind: "ok",
      threads: {},
    });

    expect(sourced.innerHTML).toContain(
      '<cite class="cite" title="src/a.ts:12-30"><button type="button" class="cite-open" data-cite="src/a.ts:12-30"><span class="cite-path">src/a.ts:</span>12-30</button></cite>',
    );
    expect(sourced.innerHTML).toContain('data-cite="src/b.ts:4,8-9"');
    expect(sourced.innerHTML).toContain("as <cite>the docs</cite> say");
    expect(sourced.innerHTML).toContain('<p class="kicker">src/a.ts:1-9 &lt;cite&gt;');
  });
});

describe("the viewer of a citation's lines", () => {
  const citation = { path: "src/a.go", lines: [{ first: 12, last: 13 }] } as const;
  const settings = settingsOf(CONFIG);

  const viewed = (viewer: Viewer): string => {
    const panel = { innerHTML: "", scrollTop: 40 };
    renderViewer(settings, panel, viewer);

    expect(panel.scrollTop).toBe(0);

    return panel.innerHTML;
  };

  test("asks for the cited lines and eight around them, from line 1 at least", () => {
    expect(linesAround(citation)).toEqual({ from: 4, to: 21 });
    expect(
      linesAround({
        path: "a",
        lines: [
          { first: 30, last: 30 },
          { first: 3, last: 5 },
        ],
      }),
    ).toEqual({ from: 1, to: 38 });
  });

  test("shows the path and a close button above the lines, numbered, the cited ones marked", () => {
    const html = viewed({ kind: "lines", citation, from: 11, lines: ["a", "<b>", "c", "d"] });

    expect(html).toContain(
      `<div class="viewer-head"><code class="viewer-path">src/a.go:12-13</code><button type="button" class="viewer-close" data-close-viewer>${WORDS.fr.viewerClose}</button></div>`,
    );
    expect(html).toContain(
      '<div class="viewer-lines"><div class="line"><span class="n">11</span><code>a</code></div>' +
        '<div class="line cited"><span class="n">12</span><code>&lt;b&gt;</code></div>' +
        '<div class="line cited"><span class="n">13</span><code>c</code></div>' +
        '<div class="line"><span class="n">14</span><code>d</code></div></div>',
    );
  });

  test("says it reads the lines, then why it could not, escaped", async () => {
    expect(viewed({ kind: "loading", citation })).toContain(WORDS.fr.viewerLoading);

    const failed = viewed({ kind: "failed", citation, message: "403 <img src=x>" });

    expect(failed).toContain(WORDS.fr.viewerFailed("403 &lt;img src=x&gt;"));
    expect(await elementsWith(failed, "img")).toBe(0);
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
