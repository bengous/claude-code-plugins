import type { Config } from "../../src/model/atlas.ts";

export default {
  title: "Deep",
  subtitle: "The specs' map five levels deep, to walk down in the browser.",
  palette: {
    a: { light: "#1f6aa8", dark: "#6fb0ea" },
    b: { light: "#8a5536", dark: "#d79a74" },
    x: { light: "#5c697b", dark: "#9aa7b8" },
    y: { light: "#76690f", dark: "#c9ba52" },
  },
  tags: { names: ["t1"], outside: "optional" },
} satisfies Config;
