# Plan Review Workflow

Multi-agent plan review requiring architect and simplifier approval before plan execution.

```
┌─────────────────────────────────────────────────────────────────────┐
│                      PLAN REVIEW WORKFLOW                           │
└─────────────────────────────────────────────────────────────────────┘

                         User writes plan
                               │
                               ▼
                    ┌─────────────────────┐
                    │   ExitPlanMode      │
                    │   (tool call)       │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  PreToolUse Hook    │
                    │  (intercepts)       │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
        ┌──────────┐    ┌──────────┐    ┌──────────┐
        │< 50 lines│    │<!-- QUICK│    │ Already  │
        │          │    │   -->    │    │ APPROVED │
        └────┬─────┘    └────┬─────┘    └────┬─────┘
             │               │               │
             └───────────────┴───────────────┘
                             │
                      BYPASS → Allow through
                             │
              ───────────────┴───────────────
                             │
                   Otherwise: BLOCK
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    ROUND 1: Independent Review                      │
│                         (parallel agents)                           │
├─────────────────────────────┬───────────────────────────────────────┤
│                             │                                       │
│   ┌─────────────────────┐   │   ┌─────────────────────┐             │
│   │  Architect Reviewer │   │   │   Code Simplifier   │             │
│   │       (Opus)        │   │   │      (Opus)         │             │
│   ├─────────────────────┤   │   ├─────────────────────┤             │
│   │ • Architecture      │   │   │ • Over-engineering  │             │
│   │ • Best practices    │   │   │ • Unnecessary code  │             │
│   │ • Scalability       │   │   │ • Simpler options   │             │
│   │ • MCP/Web research  │   │   │ • Complexity audit  │             │
│   └──────────┬──────────┘   │   └──────────┬──────────┘             │
│              │              │              │                        │
│              ▼              │              ▼                        │
│        Findings +           │        Findings +                     │
│        Agent ID             │        Agent ID                       │
└─────────────────────────────┴───────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    ROUND 2: Cross-Review Debate                     │
│                    (resume both agents in parallel)                 │
├─────────────────────────────┬───────────────────────────────────────┤
│                             │                                       │
│   ┌─────────────────────┐   │   ┌─────────────────────┐             │
│   │  Architect (resume) │◄──┼───│ Simplifier findings │             │
│   └──────────┬──────────┘   │   └─────────────────────┘             │
│              │              │                                       │
│   ┌─────────────────────┐   │   ┌─────────────────────┐             │
│   │ Architect findings  │───┼──►│ Simplifier (resume) │             │
│   └─────────────────────┘   │   └──────────┬──────────┘             │
│                             │              │                        │
│              ▼              │              ▼                        │
│    AGREE / DISAGREE /       │    AGREE / DISAGREE /                 │
│    ADD NUANCE               │    ADD NUANCE                         │
└─────────────────────────────┴───────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   ROUND 3: Consensus Formation                      │
│                      (main agent synthesizes)                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│   │    Aligned      │  │    Disputed     │  │   Withdrawn     │     │
│   │  (both agree)   │  │  (disagreement) │  │  (reconsidered) │     │
│   │                 │  │                 │  │                 │     │
│   │  → Must address │  │  → Judgment call│  │  → Can skip     │     │
│   └─────────────────┘  └─────────────────┘  └─────────────────┘     │
│                                                                     │
│   Update plan with "## Plan Review Status" section:                 │
│   • Reviews: N/3                                                    │
│   • Status: APPROVED                                                │
│   • Consensus Summary                                               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
                    ┌─────────────────────┐
                    │   ExitPlanMode      │
                    │   (retry - passes)  │
                    └──────────┬──────────┘
                               │
                               ▼
                        Plan Executes
```

## Key Features

| Feature | Description |
|---------|-------------|
| **Auto-bypass** | Plans < 50 lines or with `<!-- QUICK -->` marker skip review |
| **Max 3 cycles** | After 3 review rounds, allows through with warning |
| **Agent resume** | Round 2 reuses agent context for efficient debate |
| **Structured consensus** | Forces explicit categorization of aligned/disputed/withdrawn findings |

## Installation

```bash
/plan-review:setup-plan-review
```

## Bypass Options

For trivial changes that don't need full review:

1. **Small plans**: Plans under 50 lines automatically bypass
2. **Quick marker**: Add `<!-- QUICK -->` anywhere in the plan
