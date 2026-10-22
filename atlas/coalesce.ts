// Runs `task` on request, never two at once: the requests that come while it runs leave one run
// waiting behind it, which sees everything they asked for. Each request answers the promise of the
// runs it joined.
export function coalesced(task: () => Promise<void>): () => Promise<void> {
  let busy = false;
  let again = false;
  let current = Promise.resolve();

  // `busy` drops in the same step as the last check of `again`: a request in any later microtask
  // starts a run of its own.
  const run = async (): Promise<void> => {
    try {
      do {
        again = false;
        await task();
      } while (again);
    } finally {
      busy = false;
    }
  };

  return () => {
    if (busy) {
      again = true;

      return current;
    }

    busy = true;
    current = run();

    return current;
  };
}
