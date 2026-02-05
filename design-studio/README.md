# Design Studio

Generate 5 unique website redesigns.

## Usage

```bash
/design-studio https://example.com
```

## How It Works

1. Main agent scaffolds project, analyzes original site
2. Main agent spawns ONE designer with all context
3. Designer creates 5 designs SEQUENTIALLY (same context = natural differentiation)
4. User picks favorite
5. Optional: promote to main route

## Key Insight (Theo)

> "When the model within its context is doing multiple different designs with the instruction of making them unique, you're more likely to get unique designs than if you just roll five times because it knows the other four designs."

One agent creating 5 designs in sequence naturally differentiates because it sees its previous work. This beats 5 parallel agents that can't see each other.

## Files

```
design-studio/
├── .claude-plugin/plugin.json
├── commands/design-studio.md    # EXPLICIT orchestration
├── agents/designer.md           # Designer agent template
└── README.md
```

## Future (v2)

- Add iteration loop (user picks favorites -> new designs inspired by them)
- Add `--existing` flag to use current project instead of scaffolding
