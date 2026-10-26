import type { Config } from "../../src/model/atlas.ts";

export default {
  title: "Bands",
  subtitle: "Ranked nodes read top to bottom, in bands; the in side above, the out side below.",
  direction: "DOWN",
  palette: {
    edge: { light: "#76690f", dark: "#c9ba52" },
    shop: { light: "#1f6aa8", dark: "#6fb0ea" },
    back: { light: "#8a5536", dark: "#d79a74" },
    data: { light: "#3a5688", dark: "#8fa9de" },
    outside: { light: "#5c697b", dark: "#9aa7b8" },
  },
} satisfies Config;
