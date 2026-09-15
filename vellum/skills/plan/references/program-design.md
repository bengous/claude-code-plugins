# Program design formats

The shape of the code before any body: what a reviewer validates in a minute and an implementer cannot get wrong. Pick the formats the change calls for; a plan rarely needs more than two. Every block is plain text in a fenced code block.

## Types and signatures

For every new or changed contract: the function, its parameters and return type, the type it takes or produces. Bodies stay out. Use the project's language.

```ts
interface Cursor {
  position: ItemId
  direction: 'up' | 'down'
}

resolveTarget(items: Item[], cursor: Cursor): ItemId | null
```

## Call-stack tree

For a change in orchestration or control flow: who calls whom, top down. Diff syntax when the interesting part is what changes.

```diff
 entrypoint
   runCommand
+    handleCreateResource
+      ResourceClient.create(input)
+        POST /resources
+      renderResult
-    legacyCreateFlow
```

## File tree

For a change in layout: where new code lives, what moves, what disappears. One comment per line when the name does not say it.

```diff
 src/resource
+  resource-client.ts        # wraps the API contract
+  resource-client.test.ts
~  resource-route.ts         # wires the create action
-  legacy-create.ts
```

## Command interface

For a CLI or a script: the invocations, their options, the result codes, each result a distinct exit. The list of what the command never does, when a mistake there is expensive.

```
tool diagnose                 # read-only, writes the report
tool recover [--pause S]      # gate, then one cycle
tool confirm yes|no

results: not-ready · ambiguous · recovered · failed
never: reboot, restart the service, edit config
```

## Contract

For an endpoint or a message: the shape in, the shape out, the failure cases. A schema block or a request/response pair; the SQL of a new table or query when storage changes.

```
POST /threads/:id/comments
  in:  { body: string, parentId?: CommentId }
  out: 201 { id: CommentId, createdAt: ISO8601 } | 404 | 422 { field: string }
```

## Choosing

- A new function or type: signatures.
- A flow that changes: call-stack tree.
- Files that move or appear: file tree.
- A command: command interface.
- Anything that crosses a process or a wire: contract.

Group implementation notes by behavior, not by file. Name a file only when the change there is not obvious from the tree.
