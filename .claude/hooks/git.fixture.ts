import { $ } from "bun";

/** git in a test repository, blind to the developer's global and system config. */
export const git = (args: string[], cwd: string) =>
  $`git ${args}`
    .cwd(cwd)
    .env({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" })
    .quiet();

export const commit = (args: string[], cwd: string) =>
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", ...args], cwd);
