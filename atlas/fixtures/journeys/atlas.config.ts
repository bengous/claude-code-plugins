import type { Config } from "../../src/model/atlas.ts";

export default {
  title: "Journeys",
  subtitle: "A bookshop with two journeys; the header's Parcours menu plays one.",
  lang: "fr",
  phases: ["MVP", "v2"],
  palette: {
    edge: { light: "#5b4b8a", dark: "#a99be0" },
    app: { light: "#1f6aa8", dark: "#6fb0ea" },
    shop: { light: "#1e7a4c", dark: "#5cc28d" },
    data: { light: "#3a5688", dark: "#8fa9de" },
    outside: { light: "#5c697b", dark: "#9aa7b8" },
  },
} satisfies Config;
