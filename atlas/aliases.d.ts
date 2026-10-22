// The map the page draws: serve.ts resolves both to the files of the map folder it serves.
declare module "atlas:map" {
  const map: import("./atlas.ts").AtlasMap;
  export default map;
}

declare module "atlas:config" {
  const config: import("./atlas.ts").Config;
  export default config;
}
