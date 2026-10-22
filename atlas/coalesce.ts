// Runs `task` on request, never two at once: the requests that come while it runs leave one run
// waiting behind it, which sees everything they asked for. Each request answers the promise of the
// runs it joined.
export function coalesced(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;

  const run = async (): Promise<void> => {
    do {
      again = false;
      await task();
    } while (again);
  };

  return () => {
    if (running !== null) {
      again = true;

      return running;
    }

    running = run().finally(() => {
      running = null;
    });

    return running;
  };
}
