Invoke the `null-as-error` skill to audit the current project for silent error swallowing in Effect code.

Scan scope: $ARGUMENTS (defaults to `src/` if empty).

The skill will:
1. Check if Effect is installed (skip if not)
2. Run the scanner to find catchAll patterns that collapse errors into sentinel values
3. Spawn an auditor agent to classify each finding by severity and prescribe fixes
4. Produce a structured report with actionable recommendations
