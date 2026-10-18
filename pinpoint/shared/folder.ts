/** The last segment of a session's directory, the name the panel and "Which app?" give the session. */
export function folderName(root: string): string {
  return root.split(/[\\/]/u).findLast((segment) => segment !== "") ?? root;
}
