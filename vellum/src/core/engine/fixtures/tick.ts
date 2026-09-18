import { POLL_MS } from "./poll-ms.ts";
import type { World } from "./world.ts";

/** One poll, and the fetch and prompt it started run to their end. */
export async function tick(world: World): Promise<void> {
  await world.clock.advance(POLL_MS);
  await world.clock.settle();
}

export async function ticks(world: World, count: number): Promise<void> {
  for (let poll = 0; poll < count; poll += 1) await tick(world);
}
