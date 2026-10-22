import { describe, expect, test } from "bun:test";

import { coalesced } from "./coalesce.ts";

// A task whose runs end when the test says so.
type Gated = {
  readonly task: () => Promise<void>;
  readonly runs: () => number;
  readonly end: () => void;
};

function gated(): Gated {
  const gates: Array<PromiseWithResolvers<void>> = [];

  return {
    task: async () => {
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      await gate.promise;
    },
    runs: () => gates.length,
    end: () => {
      gates.at(-1)?.resolve();
    },
  };
}

describe("coalesced", () => {
  test("requests during a run leave one run waiting behind it, however many they are", async () => {
    const { task, runs, end } = gated();
    const request = coalesced(task);
    const first = request();

    for (let i = 0; i < 20; i += 1) {
      void request();
    }

    expect(runs()).toBe(1);

    end();
    await Bun.sleep(0);

    expect(runs()).toBe(2);

    end();
    await first;

    expect(runs()).toBe(2);
  });

  test("a request once the runs ended starts a new run", async () => {
    const { task, runs, end } = gated();
    const request = coalesced(task);
    const first = request();
    end();
    await first;
    const second = request();

    expect(runs()).toBe(2);

    end();
    await second;
  });

  test("a run that fails rejects the request, and a later request runs again", async () => {
    let calls = 0;

    const request = coalesced(async () => {
      calls += 1;
      await Bun.sleep(0);

      if (calls === 1) {
        throw new Error("the build broke");
      }
    });

    await expect(request()).rejects.toThrow("the build broke");
    await request();

    expect(calls).toBe(2);
  });
});
