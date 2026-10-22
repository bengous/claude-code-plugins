import type { Edge } from "./model.ts";
import { edgeAdder } from "./model.ts";

// E(from, to, label, opts): one arrow, from → to.
//   from, to  brick ids. The detail draws every one of these arrows; the
//             overview draws one arrow per pair of boxes these arrows join
//             (a zone, or a service outside every zone).
//   label     what moves along the arrow (a call, a protocol, a table); keep
//             it to a few words
// Overview labels: an arrow with "z:<zone>" on one or both ends names the
// overview arrow between those two boxes, instead of the joined labels of
// the bricks' arrows. At least one brick arrow must join the two boxes in
// that direction (check.ts).
// Options:
//   kind      "deny" (red: refused) or "dash" (dormant, local only, or on demand)
//   two       arrowheads at both ends; on an overview label, it also merges
//             the two directions between those boxes into one arrow
//   data      the tags the arrow carries, from the closed list of
//             model.ts; required on an arrow into a third-party service
// engine.ts routes every arrow: there are no coordinates here.
export const edges: Edge[] = [];

const E = edgeAdder(edges);

// Overview labels
E("z:app", "z:data", "SQL");

E("z:app", "email", "order mail");

// Bricks
E("browser", "proxy", "HTTPS");

E("proxy", "web", "HTTP app:3000");

E("web", "catalog", "list, search");

E("web", "orders", "checkout");

E("catalog", "db", "SQL books");

E("orders", "db", "SQL orders");

E("orders", "email", "confirmation", { data: ["account", "order"] });

E("backup", "db", "pg_dump each night", { kind: "dash" });
