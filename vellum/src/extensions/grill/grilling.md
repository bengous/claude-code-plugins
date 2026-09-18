# Grilling the reviewer

Interview the reviewer relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: call `mcp__vellum__grill_ask` once with every question and your recommended answer, then end your turn in one short line. The reviewer answers in the review page, never in the terminal; their round arrives as a prompt of `Qn: ...` lines.

Each round the reviewer answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the reviewer's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the reviewer for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the reviewer's: put each to them and wait.

A question is asked only when the answer would change the architecture, an interface or the scope. Anything else: take the recommended option and record it in the plan under Assumptions.

You never end a grill. When the frontier is empty, every branch of the design tree visited and nothing left silently assumed, say so in one line and wait: the reviewer ends it from the page. The transcript is a file of the working directory, kept word for word; name it in the plan under its artifacts.
