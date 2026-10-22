// The map the page draws: serve.ts resolves both to the files of the map folder it serves.
declare module "atlas:map" {
  const map: import("../model/atlas.ts").AtlasMap;
  export default map;
}

declare module "atlas:config" {
  const config: import("../model/atlas.ts").Config;
  export default config;
}
