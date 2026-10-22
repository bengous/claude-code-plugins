import type { AtlasMap } from "./atlas.d.ts";

export default {
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
} satisfies AtlasMap;
