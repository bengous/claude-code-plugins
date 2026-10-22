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

  // The first run asks again `depth` microtasks after its task settled: whatever the depth, the
  // runs are over or about to check, and that request gets a run of its own.
  test.each([0, 1, 2, 3, 4, 5, 6, 7, 8])(
    "a request %i microtasks after a run's task settled still runs",
    async (depth) => {
      let runs = 0;
      let runsBefore = 0;
      let late: Promise<void> = Promise.resolve();

      const after = (n: number, then: () => void): void => {
        if (n === 0) {
          then();

          return;
        }

        void Promise.resolve().then(() => {
          after(n - 1, then);
        });
      };

      // oxlint-disable-next-line require-await -- an async task that returns its promise unawaited settles at the microtask depth whose window this test covers.
      const request = coalesced(async () => {
        runs += 1;

        if (runs === 1) {
          const settled = Promise.resolve();

          void settled.then(() => {
            after(depth, () => {
              runsBefore = runs;
              late = request();
            });
          });

          return settled;
        }
      });

      await request();
      await Bun.sleep(10);
      await late;

      expect(runs).toBe(runsBefore + 1);
    },
  );

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
