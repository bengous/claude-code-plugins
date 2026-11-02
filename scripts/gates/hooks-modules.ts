import { join } from "node:path";

interface Catalog {
  plugins: { source: string }[];
}

interface HooksFile {
  modules?: string[];
}

/** The catalog's plugins that carry a hooks module, in catalog order, by directory. */
export async function hooksModulePlugins(repoRoot: string): Promise<string[]> {
  const catalog: Catalog = await Bun.file(join(repoRoot, ".claude-plugin/marketplace.json")).json();
  const directories = catalog.plugins.map((plugin) => plugin.source.replace(/^\.\//u, ""));

  const hasModules = await Promise.all(
    directories.map(async (directory) => {
      const hooks = Bun.file(join(repoRoot, directory, "hooks/hooks.json"));

      if (!(await hooks.exists())) return false;
      const parsed: HooksFile = await hooks.json();

      return (parsed.modules ?? []).length > 0;
    }),
  );

  return directories.filter((_, index) => hasModules[index] === true);
}
