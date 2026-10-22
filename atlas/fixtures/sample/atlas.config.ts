import type { Config } from "./atlas.d.ts";

export default {
  title: "Bookshop",
  subtitle: "A sample map. One zone per machine or module, one brick per replaceable component.",
  lang: "fr",
  palette: {
    clients: { light: "#76690f", dark: "#c9ba52" },
    server: { light: "#8a5536", dark: "#d79a74" },
    app: { light: "#1f6aa8", dark: "#6fb0ea" },
    data: { light: "#3a5688", dark: "#8fa9de" },
    external: { light: "#5c697b", dark: "#9aa7b8" },
  },
  pins: "shared",
  overview: { ratio: "screen" },
  tags: { names: ["account", "order", "payment", "none"], outside: "required" },
  legend: { outside: "hors du serveur" },
} satisfies Config;
