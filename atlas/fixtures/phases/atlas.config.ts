import type { Config } from "../../src/model/atlas.ts";

export default {
  title: "Phased shop",
  subtitle: "A shop built in three work phases; the header picks one.",
  lang: "fr",
  phases: ["MVP", "Payments", "Growth"],
  palette: {
    store: { light: "#1f6aa8", dark: "#6fb0ea" },
    billing: { light: "#8a5536", dark: "#d79a74" },
    data: { light: "#3a5688", dark: "#8fa9de" },
    outside: { light: "#5c697b", dark: "#9aa7b8" },
  },
} satisfies Config;
