#!/usr/bin/env python3
"""SubagentStop: Verify t-plan subagent wrote required output.

This hook enforces t-plan "contracts" at the end of subagent runs:
- EXPLORE must write `explore.md`
- SCOUT must write `scout.md`
- VALIDATE must write `validation-vNNN.json` matching `draft_version`

The expected contract is determined by `.t-plan/<session_id>/state.json`.
"""

import json
import sys
from pathlib import Path
from typing import Optional

PHASE_CONTRACTS = {
    "EXPLORE": "explore.md",
    "SCOUT": "scout.md",
    "VALIDATE": "validation-v{version}.json",
}


def _find_session_dir(start: Path, session_id: str) -> Optional[Path]:
    # Walk upward so this works even if the hook runs from a subdirectory.
    for candidate_root in (start, *start.parents):
        session_dir = candidate_root / ".t-plan" / session_id
        if (session_dir / "state.json").exists():
            return session_dir
    return None


def _fail(message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(2)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    session_id = data.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        sys.exit(0)

    cwd = Path(data.get("cwd") or Path.cwd())
    session_dir = _find_session_dir(cwd, session_id)
    if session_dir is None:
        sys.exit(0)

    state_file = session_dir / "state.json"
    try:
        state = json.loads(state_file.read_text())
    except Exception as exc:
        _fail(f"CONTRACT UNFULFILLED: invalid state.json ({exc})")

    phase = state.get("phase", "")

    if phase not in PHASE_CONTRACTS:
        sys.exit(0)

    expected = PHASE_CONTRACTS[phase]
    if "{version}" in expected:
        validation_version = state.get("validation_version")
        if isinstance(validation_version, str) and validation_version.isdigit():
            validation_version = int(validation_version)
        if not isinstance(validation_version, int) or validation_version < 1:
            _fail("CONTRACT UNFULFILLED: state.validation_version must be >= 1 for VALIDATE")
        expected = expected.format(version=str(validation_version).zfill(3))

    output = session_dir / expected

    if not output.exists() or output.stat().st_size == 0:
        _fail(f"CONTRACT UNFULFILLED: {phase} must write to {expected}")

    # Additional check for VALIDATE: JSON must be parseable and match draft_version
    if phase == "VALIDATE":
        try:
            validation = json.loads(output.read_text())
            file_draft = validation.get("draft_version")
            expected_draft = state.get("draft_version")

            try:
                file_draft_int = int(file_draft)
                expected_draft_int = int(expected_draft)
            except (TypeError, ValueError):
                _fail(
                    "CONTRACT UNFULFILLED: "
                    f"draft_version must be an integer (got {file_draft!r} vs {expected_draft!r})"
                )

            if file_draft_int != expected_draft_int:
                _fail(
                    "CONTRACT UNFULFILLED: "
                    f"validation draft_version ({file_draft}) != state ({expected_draft})"
                )
            if "status" not in validation:
                _fail("CONTRACT UNFULFILLED: validation JSON missing required field 'status'")
        except json.JSONDecodeError:
            _fail(f"CONTRACT UNFULFILLED: {expected} is not valid JSON")

    sys.exit(0)


if __name__ == "__main__":
    main()
