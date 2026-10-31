import type { AtlasMap, Filled } from "./atlas.d.ts";

const map = {
  root: {
    title: "New map",
    children: [
      {
        id: "system",
        label: "System",
        sub: "what runs it",
        color: "system",
        children: [
          {
            id: "part",
            label: "Part",
            sub: "one responsibility",
            color: "system",
            children: [{ id: "component", label: "Component", sub: "its source", color: "system" }],
          },
        ],
      },
    ],
  },
  links: [],
} as const satisfies AtlasMap;

export default map satisfies Filled<typeof map>;
