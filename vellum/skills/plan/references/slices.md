# Vertical slices

A slice connects only the parts needed for one observable result, end to end. It ends with something the reviewer can run, see or query. The check is named in the plan: the command, the URL, the screen.

## The order

Horizontal order (migrations, then services, then API, then UI) leaves nothing checkable before the end. Build vertically:

1. The contract, serving fixed data. Check with curl or a test.
2. The consumer on that fixed data: UI, CLI output, caller. Iterate on what the reviewer sees.
3. The contract wired to the real logic, still on fixed storage.
4. Storage: migration, real data.
5. Business rules.
6. Error handling and edge cases.

A change without a UI keeps the same idea: first the seam that proves the shape, then the parts behind it.

## Sizing a slice

- One slice, one thing to check. Two checks means two slices.
- A slice the reviewer would not test is too small to be one; fold it into its neighbor.
- A slice whose check needs the next slice is in the wrong order.
- Setup, configuration and documentation ride with the slice that needs them.

## During implementation

Deviations from the plan go in a short implementation-notes file next to it, one line each: what the plan said, what was done, why. The reviewer reads it before the pull request.
