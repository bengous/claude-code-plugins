import type { Lang, LegendKey } from "./atlas.ts";

// The page's own words in each language a Config may pick: everything the engine writes on the
// page, and nothing of the map's content. The panel inserts them as HTML, so each is HTML-safe,
// and a function's arguments arrive escaped where the panel inserts the result as HTML.
export type Words = {
  readonly home: string;
  readonly fitButton: string;
  readonly legendButton: string;
  readonly panelButton: string;
  readonly hint: string;
  /** The tooltip of each copy of a node drawn twice, in both columns. */
  readonly copies: {
    readonly source: (label: string) => string;
    readonly target: (label: string) => string;
  };
  readonly position: string;
  readonly stage: string;
  readonly mapLabel: (title: string) => string;
  readonly zoneLabel: (title: string) => string;
  readonly legend: Readonly<Record<LegendKey, string>>;
  readonly openPoints: string;
  readonly openCount: (count: number) => string;
  readonly openSum: (human: number, agent: number, humanName: string | null) => string;
  readonly owner: { readonly container: string; readonly leaf: string };
  readonly waits: (who: string | null) => string;
  readonly unreadable: (why: string) => string;
  readonly replyPlaceholder: (who: string) => string;
  readonly replyLabel: (id: string) => string;
  readonly reply: string;
  readonly replyRefused: (why: string) => string;
  readonly io: string;
  readonly swap: string;
  readonly coupledWith: string;
  readonly extend: string;
  readonly pitfalls: string;
  readonly seams: string;
  readonly traps: string;
  readonly why: string;
  readonly alt: string;
  readonly facts: string;
  readonly how: string;
  readonly see: string;
  readonly source: (src: string) => string;
  readonly zones: string;
  readonly arrowsMissing: string;
  readonly avoidFailed: (error: string) => string;
  readonly drawFailed: (error: string) => string;
};

const fr: Words = {
  home: "Vue d'ensemble",
  fitButton: "Ajuster",
  legendButton: "Légende",
  panelButton: "Panneau",
  hint: "clic sur une boîte pour y entrer, sur une carte pour la choisir · molette pour zoomer, glisser pour déplacer · Échap ou clic sur le fond pour remonter",
  copies: {
    source: (label) => `${label} — ses flèches partent d'ici`,
    target: (label) => `${label} — ses flèches arrivent ici`,
  },
  position: "Position dans le plan",
  stage: "Plan zoomable",
  mapLabel: (title) => `Architecture de ${title}`,
  zoneLabel: (title) => `Zone ${title}`,
  legend: {
    flow: "flux",
    dash: "en sommeil, local ou sur demande",
    deny: "refusé",
    coupled: "change avec la brique choisie",
    outside: "hors du système",
    open: "point ouvert",
  },
  openPoints: "Points ouverts",
  openCount: (count) => `Points ouverts : ${count}`,
  openSum: (human, agent, humanName) =>
    `${human} attendent ${humanName ?? "l'humain"} · ${agent} attendent un agent`,
  owner: { container: "zone", leaf: "brique" },
  waits: (who) => `attend : ${who ?? "personne"}`,
  unreadable: (why) => `Fils illisibles : ${why}`,
  replyPlaceholder: (who) => `Répondre (${who})`,
  replyLabel: (id) => `Répondre à ${id}`,
  reply: "Répondre",
  replyRefused: (why) => `Réponse refusée : ${why}`,
  io: "Contrat",
  swap: "Pour remplacer",
  coupledWith: "Change avec, entouré sur le plan :",
  extend: "Pour étendre",
  pitfalls: "Pièges",
  seams: "Points d'extension",
  traps: "Couplages à connaître",
  why: "Pourquoi",
  alt: "Écarté ou reporté",
  facts: "Repères",
  how: "Lecture",
  see: "Voir aussi",
  source: (src) => `Source : ${src}`,
  zones: "Zones",
  arrowsMissing: "Flèches absentes",
  avoidFailed: (error) =>
    `libavoid ne s'est pas chargé : cette vue n'a pas ses flèches. Le plan doit être servi par <code>bun atlas/serve.ts &lt;dossier du plan&gt;</code>, qui sert aussi <code>libavoid.wasm</code>. Erreur : <code>${error}</code>`,
  drawFailed: (error) => `Le plan n'a pas pu se dessiner : <code>${error}</code>`,
};

const en: Words = {
  home: "Overview",
  fitButton: "Fit",
  legendButton: "Legend",
  panelButton: "Panel",
  hint: "click a box to enter it, a card to select it · wheel to zoom, drag to pan · Escape or a click on the background to go up",
  copies: {
    source: (label) => `${label} — its arrows leave from here`,
    target: (label) => `${label} — its arrows arrive here`,
  },
  position: "Position in the map",
  stage: "Zoomable map",
  mapLabel: (title) => `Architecture of ${title}`,
  zoneLabel: (title) => `Zone ${title}`,
  legend: {
    flow: "flow",
    dash: "dormant, local or on demand",
    deny: "refused",
    coupled: "changes with the selected brick",
    outside: "outside the system",
    open: "open point",
  },
  openPoints: "Open points",
  openCount: (count) => `Open points: ${count}`,
  openSum: (human, agent, humanName) =>
    `${human} wait for ${humanName ?? "the human"} · ${agent} wait for an agent`,
  owner: { container: "zone", leaf: "brick" },
  waits: (who) => `waits for: ${who ?? "nobody"}`,
  unreadable: (why) => `Threads unreadable: ${why}`,
  replyPlaceholder: (who) => `Reply (${who})`,
  replyLabel: (id) => `Reply to ${id}`,
  reply: "Reply",
  replyRefused: (why) => `Reply refused: ${why}`,
  io: "Contract",
  swap: "To replace",
  coupledWith: "Changes with it, outlined on the map:",
  extend: "To extend",
  pitfalls: "Pitfalls",
  seams: "Extension points",
  traps: "Couplings to know",
  why: "Why",
  alt: "Rejected or postponed",
  facts: "Facts",
  how: "How to read",
  see: "See also",
  source: (src) => `Source: ${src}`,
  zones: "Zones",
  arrowsMissing: "Arrows missing",
  avoidFailed: (error) =>
    `libavoid did not load: this view has no arrows. The map must be served by <code>bun atlas/serve.ts &lt;map folder&gt;</code>, which also serves <code>libavoid.wasm</code>. Error: <code>${error}</code>`,
  drawFailed: (error) => `The map could not be drawn: <code>${error}</code>`,
};

export const WORDS: Readonly<Record<Lang, Words>> = { fr, en };
