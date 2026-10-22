// Nothing here has a position or a size: engine.ts lays the plan out from
// the nesting of the zones, their bricks and the arrows.
//
// Every `info` object (overview, zones, nodes) feeds the right panel. All
// fields are optional; HTML is allowed (<code>), and the panel shows them in
// this order:
//   kicker  small mono line above the title: the source file and lines
//   title   panel heading
//   lead    what it is, in one or two sentences
//   io      [["Receives", …], ["Produces", …]]: the brick's contract
//   swap    what to touch to replace or remove it ("Pour remplacer")
//   extend  the way to grow it ("Pour étendre")
//   pitfalls  non-obvious traps of this brick ("Pièges")
//   seams, traps   overview only: [brickId, text] extension points and couplings
//   why     list of reasons for the current choice
//   alt     alternatives already rejected or postponed
//   facts   [label, value] pairs
//   open    zones and bricks only: the open points, [{ id, text }]. The id is
//           kebab-case, unique on the whole plan, and never changes: the
//           thread of the point lives under it in threads.json, and the page
//           and `check.ts --open` cite it. The text describes a state, never
//           a step: check.ts refuses step names (A1, F2a, I1) and step words.
//           Its thread is a list of { who, text }, who being human or
//           agent; the point waits for the party that did not write last.
//           `bun check.ts --open` lists the points and who each waits for;
//           `bun reply.ts <id> --as agent "<text>"` answers (an agent always
//           writes as agent), and so does the panel's reply form, as
//           human. A settled point is deleted with its thread.
//   how     reading instructions (overview)
//   see     ids of related zones or bricks, as chips
//   src     longer source reference, at the bottom
import type { Overview, Zone } from "./model.ts";

export const OVERVIEW: Overview = {
  kicker: "a sample map",
  title: "Bookshop",
  lead: "A small online bookshop: readers browse the catalog and order books from their browser; one server runs the application behind a reverse proxy and keeps the data in PostgreSQL; an outside service sends the order mails.",
  why: [
    "One process serves the pages and the orders: the shop is small enough that a second service would cost more than it saves.",
    "The database is the only state: the application keeps nothing on its own disk.",
  ],
  facts: [
    ["Code", "TypeScript on Bun"],
    ["Data", "PostgreSQL"],
    ["Mail", "an outside email service"],
  ],
  how: "The overview shows the server with its application and its storage, the clients on the left and the email service on the right. A click on a zone or a brick opens the detail: every brick and every arrow, and on the arrow into the email service the tags it carries.",
  seams: [
    [
      "catalog",
      "A new way to browse = a query in <code>catalog</code> and its route in <code>web</code>.",
    ],
  ],
  traps: [
    [
      "orders",
      "An order is written and its mail sent in one request: a slow email service slows the checkout.",
    ],
  ],
  src: "a sample written for the atlas plugin",
};

// A zone is a part of the system (a machine, an application, a store) drawn
// as a frame around its bricks. The overview shows `title`, `tag` and the
// names of its bricks; the panel opens on `kw`, three keywords.
//   parent      the zone that contains this one. Zones sharing a parent are
//               packed in this order.
//   ext: true   dashed frame, outside the server
//   side        for an ext zone, its overview column: "in" (left) or "out" (right)
//   color       a --z-* token of plan.fr.html
export const ZONES: Zone[] = [
  {
    id: "clients",
    ext: true,
    side: "in",
    color: "--z-olive",
    title: "Clients",
    tag: "outside the server",
    kw: ["the reader's browser", "HTTPS only", "no account needed to browse"],
    info: {
      title: "Clients",
      lead: "Where readers come from: a browser on a computer or a phone.",
      see: ["browser"],
    },
  },
  {
    id: "server",
    color: "--z-brown",
    title: "Server",
    tag: "one virtual machine",
    kw: ["reverse proxy in front", "one application process", "one database"],
    info: {
      kicker: "deploy/",
      title: "Server",
      lead: "One virtual machine runs the reverse proxy, the application and the database. Only the proxy listens on the network.",
      facts: [["Ports", "443 only"]],
      see: ["proxy", "app", "data"],
      src: "deploy/compose.yml",
    },
  },
  {
    id: "app",
    parent: "server",
    color: "--z-blue",
    title: "Application",
    tag: "Bun process",
    kw: ["pages and routes", "catalog", "orders"],
    info: {
      kicker: "src/",
      title: "Application",
      lead: "One Bun process serves the pages, answers the catalog queries and takes the orders.",
      see: ["web", "catalog", "orders"],
      src: "src/",
    },
  },
  {
    id: "data",
    parent: "server",
    color: "--z-indigo",
    title: "Storage",
    tag: "PostgreSQL",
    kw: ["books and orders", "one database", "a dump each night"],
    info: {
      kicker: "deploy/compose.yml",
      title: "Storage",
      lead: "PostgreSQL holds the books and the orders; a nightly job dumps it.",
      see: ["db", "backup"],
      src: "deploy/compose.yml",
    },
  },
];

export const ZONE_ORDER: readonly string[] = ["clients", "server", "app", "data"];
