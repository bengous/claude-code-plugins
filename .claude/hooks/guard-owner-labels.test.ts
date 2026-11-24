import { describe, expect, test } from "bun:test";

import { denial, refusal } from "./guard-owner-labels.ts";

describe("guard-owner-labels denies an agent's owner move", () => {
  test.each([
    "gh pr edit 12 --add-label human-approved",
    "gh pr edit 12 --add-label tier:human,human-approved",
    "gh pr edit 12 --add-label tier:human --add-label human-approved",
    "gh issue edit https://github.com/o/n/pull/12 --add-label 'bug, human-approved'",
    "gh pr edit --add-label=human-approved",
    "gh pr edit 12 --add-label HUMAN-APPROVED",
    "gh pr create --base dev --label human-approved",
    "gh pr create --base dev -l human-approved",
    "gh api -X POST repos/o/n/issues/12/labels -f 'labels[]=human-approved'",
    "gh api -X PATCH repos/o/n/issues/12 -f 'labels[]=human-approved'",
    `curl -X POST -d '{"labels":["human-approved"]}' https://api.github.com/repos/o/n/issues/12/labels`,
    `curl -s -H "Authorization: token T" -d'{"labels":["human-approved"]}' https://api.github.com/repos/o/n/issues/12/labels`,
    'L=human-approved; gh pr edit 12 --add-label "$L"',
    "git rev-parse HEAD | xargs -I{} gh pr edit 12 --add-label human-approved",
    "git fetch & gh pr edit 12 --add-label human-approved",
    'gh api repos/o/n/issues/12/labels --input - <<\'EOF\'\n{"labels":["human-approved"]}\nEOF',
    'gh api -X PATCH repos/o/n/issues/12 --input - <<\'EOF\'\n{"labels":["human-approved"]}\nEOF',
    `echo '{"labels":["human-approved"]}' | gh api repos/o/n/issues/12/labels --input -`,
    "LABELS='tier:human,human-approved'; gh pr edit 12 --add-label \"$LABELS\"",
    'for l in human-approved; do gh pr edit 12 --add-label "$l"; done',
    'gh pr edit 12 --add-label "${LABEL:-human-approved}"',
  ])("the approval put on: %s", (command) => {
    expect(refusal(command)).toContain("human-approved is the owner's to put on");
  });

  test.each([
    "gh issue edit 40 --add-label ready",
    "gh issue edit 40 --add-label 'bug, ready'",
    "gh issue create --title t --body b --label ready",
    "gh issue create --title t --body b -l bug,ready",
    "gh api -X POST repos/o/n/issues/40/labels -f 'labels[]=ready'",
    `curl -X POST -d '{"labels":["ready"]}' https://api.github.com/repos/o/n/issues/40/labels`,
    'L=ready; gh issue edit 40 --add-label "$L"',
    "gh issue edit 40 --add-label ready>/dev/null",
    "(gh issue edit 40 --add-label ready)",
    'gh issue edit 40 --body "see the thread" --add-label ready',
  ])("an issue started: %s", (command) => {
    expect(refusal(command)).toContain("ready is the owner's to put on");
  });

  test.each([
    "gh pr edit 12 --remove-label needs-human",
    "gh issue edit 40 --remove-label=needs-human",
    "gh api -X DELETE repos/o/n/issues/12/labels/needs-human",
    "gh api --method DELETE repos/o/n/issues/12/labels/needs-human",
    "curl -X DELETE https://api.github.com/repos/o/n/issues/12/labels/needs-human",
    'L=needs-human; gh pr edit 12 --remove-label "$L"',
    "gh api -X GET repos/o/n/pulls/12 --jq .number | xargs -I{} gh api -X DELETE repos/o/n/issues/{}/labels/needs-human",
  ])("a stopped pull request restarted: %s", (command) => {
    expect(refusal(command)).toContain("needs-human is the owner's to take off");
  });

  test.each([
    ["ready", "gh issue create --title t --body b \\\n  --label ready"],
    ["needs-human", "gh api \\\n  -X DELETE repos/o/n/issues/12/labels/needs-human"],
    [
      "human-approved",
      `curl -X POST https://api.github.com/repos/o/n/issues/12/labels -d '{\n  "labels": ["human-approved"]\n}'`,
    ],
    [
      "human-approved",
      'gh pr comment 12 --body "use cat <<EOF for bodies"\ngh pr edit 12 --add-label human-approved',
    ],
    ["human-approved", "n=2; echo $((1<<n))\ngh pr edit 12 --add-label human-approved"],
    ["human-approved", "bash -c 'gh pr edit 12 --add-label human-approved'"],
  ])("a move of %s written over several lines: %s", (label, command) => {
    expect(refusal(command)).toContain(`${label} is the owner's to`);
  });

  test.each([
    "gh label delete needs-human --yes",
    "gh label edit needs-human --name stopped",
    "gh label edit tier:human --name human-approved",
  ])("a label renamed or deleted on every issue at once: %s", (command) => {
    expect(refusal(command)).toContain("renames or deletes a label");
  });

  test.each([
    "gh api -X PUT repos/o/n/issues/12/labels -f 'labels[]=tier:low'",
    "gh api -X PATCH repos/o/n/issues/12 -f 'labels[]=tier:low'",
    "gh api -X DELETE repos/o/n/issues/12/labels",
    `curl -X PUT -d '{"labels":["tier:low"]}' https://api.github.com/repos/o/n/issues/12/labels`,
    'gh api -X PATCH repos/o/n/issues/12 --input - <<\'EOF\'\n{"labels":["tier:low"]}\nEOF',
  ])("every label of an issue replaced or cleared: %s", (command) => {
    expect(refusal(command)).toContain("replaces or clears every label of an issue");
  });

  test("says whose move it is in every reason", () => {
    for (const command of [
      "gh pr edit 12 --add-label human-approved",
      "gh issue edit 40 --add-label ready",
      "gh pr edit 12 --remove-label needs-human",
    ]) {
      expect(refusal(command)).toContain("Ask the owner: the move is his, made on GitHub.");
    }
  });
});

describe("guard-owner-labels lets through what makes none of the owner's moves", () => {
  test.each([
    "gh pr view 12 --json labels",
    "gh pr view 12 --json labels --jq '.labels[].name' | grep human-approved",
    "grep -rn human-approved scripts",
    "git log --grep human-approved",
    'git commit -m "feat(release): gh pr edit --add-label human-approved is the owner\'s"',
    "gh pr edit 12 --add-label tier:human",
    "gh api repos/o/n/issues/12/labels",
    "gh api repos/o/n/issues/12/labels --jq '.[].name' | grep -q human-approved",
    `gh api repos/o/n/issues/12/timeline --jq '.[] | select(.label.name=="human-approved")'`,
    `curl -s https://api.github.com/repos/o/n/issues/12/labels | jq '.[] | select(.name=="ready")'`,
    "gh pr view 12 --json labels | grep human-approved; gh pr edit 12 --add-label tier:human",
    'grep -c human-approved docs/x.md; gh pr edit 12 --body-file "$TMPDIR/body.md"',
    "gh pr edit 12 --remove-label human-approved",
    "gh issue edit 40 --remove-label ready",
    "gh pr edit 12 --add-label needs-human",
    "gh api -X POST repos/o/n/issues/12/labels -f 'labels[]=needs-human'",
    "gh pr ready 12",
    "gh issue list --label ready",
    "gh issue list -l ready --json number",
    'gh pr edit 12 --body "ready to read"',
    'gh pr comment 12 --body "ready once the label is on"',
    "gh issue edit 40 --add-label ready-to-read",
    "gh issue edit 40 --add-label already",
    'gh api -X POST repos/o/n/issues/12/comments -f body="ready to read"',
    "gh label create ready --description 'The owner starts a cloud session on this issue'",
    "gh label create human-approved --color 0e8a16",
    "ls -l ready",
    'gh api -X POST repos/o/n/issues/12/comments -f body="Labels updated, ready for review"',
    "gh api repos/o/n/pulls/12/comments/99/replies -f body='Declined: owner-gate reads the human-approved label, not this file'",
    "gh api repos/o/n/pulls/12/comments/99/replies -f body='Fixed: the hook now denies --add-label human-approved'",
    'gh pr comment 12 --body "Fixed: gh pr edit --add-label human-approved is now denied"',
    'gh pr create --base dev --title "x" --body "the hook denies --add-label human-approved" --label tier:human',
    "gh api -X GET repos/o/n/issues -f labels=ready",
    "gh api repos/o/n/issues -X GET -f labels=ready -f state=open",
    "gh api search/issues -X GET -f q='repo:o/n label:ready is:open'",
    'gh pr ready 12; gh pr edit 12 --add-label "$TIER"',
    'gh pr ready 12 && gh pr edit 12 --add-label "tier:$TIER"',
    'gh issue create --title "Bump is ready" --body-file /tmp/b.md --label "$LEADS_LABEL"',
    'git commit -m "feat(repo): guard owner labels\n\nA session\'s gh pr edit --add-label human-approved is denied."',
    "git commit -m \"$(cat <<'EOF'\nfeat(repo): guard owner labels\n\nA session's gh pr edit --add-label human-approved is denied.\nEOF\n)\"",
    "gh api -X DELETE repos/o/n/issues/12/labels/tier%3Alow",
    'gh pr create --base dev --title "feat(repo): guard" --body "$(cat <<\'EOF\'\nCloses #4.\n\nA session\'s "owner moves" are denied:\n+ gh pr edit 12 --add-label human-approved -> denied\nEOF\n)"',
    'git commit -m "$(cat <<\'EOF\'\nfeat(repo): guard "owner" labels\n\nA session\'s gh pr edit --add-label human-approved is denied.\nEOF\n)"',
    'gh pr comment 12 --body "$(cat <<\'EOF\'\nRound 2: the "review" check is red.\nNext: gh pr edit 12 --remove-label needs-human is the owner\'s.\nEOF\n)"',
    "gh pr comment 12 --body-file - <<'EOF'\nDeclined: gh issue edit 40 --add-label ready is the owner's.\nEOF",
    "gh api repos/o/n/pulls/12/comments/99/replies -F body=@- <<'EOF'\nFixed: --add-label human-approved is denied now.\nEOF",
    "git commit -F - <<'EOF'\nfeat(repo): guard owner labels\n\ngh pr edit --add-label human-approved is denied.\nEOF",
    'gh pr edit 12 --body "$(cat <<\'EOF\'\nUses "gh api".\n- a PUT on gh api -X PUT repos/o/n/issues/12/labels is denied\nEOF\n)"',
    'gh issue create --title "Bump x" --label "$LEADS_LABEL" --body-file - <<\'EOF\'\nThe owner adds the "ready" label when he wants it.\nEOF',
    'gh pr create --base dev --title x --label "$TIER" --body-file - <<\'EOF\'\nThe hook keeps "human-approved" the owner\'s.\nEOF',
    "gh api -X PATCH repos/o/n/pulls/12 -f base=dev",
    "gh api -X PATCH repos/o/n/issues/12 -f state=closed",
    "gh pr merge 12 --auto --squash",
    'gh issue close 40 --comment "Superseded; the owner runs gh issue edit 41 --add-label ready"',
    'gh pr merge 12 --squash --subject "feat: deny --add-label human-approved"',
    "gh label create human-approved --description 'Owner only: gh pr edit --add-label human-approved'",
    'echo "next: gh pr edit 12 --add-label human-approved (owner)"',
    'gh api repos/o/n/pulls/12/comments/99/replies --input - <<\'EOF\'\n{"body": "the search uses labels=ready"}\nEOF',
    "gh label edit tier:human --description 'Waits for the owner'",
    "gh pr close 12 -c 'Replaced: gh pr edit 13 --add-label human-approved is the owner one'",
    "gh api -X PUT repos/o/n/rulesets/9 --input ruleset.json",
  ])("%s", (command) => {
    expect(refusal(command)).toBeNull();
  });
});

describe("denial", () => {
  test("is PreToolUse's deny, with the reason", () => {
    expect(JSON.parse(denial("why"))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "why",
      },
    });
  });
});
