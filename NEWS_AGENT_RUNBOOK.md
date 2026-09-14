# News feature: orchestrator–worker execution protocol

This runbook executes [NEWS_IMPLEMENTATION_PLAN.md](NEWS_IMPLEMENTATION_PLAN.md). The authoritative task ledger is [NEWS_TASKS.json](NEWS_TASKS.json). All feature tasks are initially planned. Writing this runbook does not start implementation, deployment, or live Discord posting.

## 1. Operating model

Use the coding environment's existing subagent tools. Do not add an orchestration SDK to the bot or build a separate autonomous-agent application for this feature. The orchestration is a development workflow with persistent task contracts and evidence.

The orchestrator owns the product contract, dependency graph, task assignment, integration, and final acceptance. Workers may explore, implement, verify, and propose better interfaces within their task. A separate read-only reviewer provides independent evaluation. An explorer is useful for uncertain source formats, unfamiliar code paths, or a repeated failure; it is optional when the task packet already contains current, sufficient context.

The default cycle is **dispatch → focused exploration if needed → implementation and self-checks → independent review → repair/re-review when required → orchestrator integration and acceptance**. The orchestrator can change decomposition when evidence reveals a bad seam. Acceptance criteria cannot be weakened by an implementer or reviewer to make a task pass.

This applies the role/context and evaluation guidance cited in the implementation plan. The concurrency and repair limits below are deliberately modest project defaults, not universal research results.

## 2. State, artifacts, and ownership

Only the orchestrator updates `NEWS_TASKS.json`. Workers return evidence; they do not mark themselves accepted. Write per-task execution artifacts under a local, orchestrator-selected directory such as `.news-work/N06/`. Ignore that temporary directory through local Git exclude rules, or explicitly select its sanitized artifacts for a final review packet. Never accidentally commit logs, source-page dumps, IDs, credentials, or unrelated user changes.

Suggested per-task artifacts:

- `task.json`: frozen assignment including revision and scope.
- `context.md`: concise facts, symbols, source observations, and unresolved assumptions.
- `implementation.json`: diff identity, outcomes, and check evidence.
- `review-1.json`, `review-2.json`: findings against immutable revisions.
- `dispositions.json`: how each finding was fixed or disputed.
- `acceptance.json`: orchestrator decision on the integrated revision.

The checked-in product plan and ledger are sufficient to discover the task structure. Temporary artifacts provide detail for a running execution. If execution must resume on another machine, preserve a sanitized review packet and its referenced commits; a path to an inaccessible `/tmp` file is not a durable handoff.

Task states:

- `planned`: waiting for accepted dependencies.
- `ready`: dependencies accepted and no unresolved contract blocker.
- `exploring`: a specific uncertainty is being investigated.
- `implementing`: one assigned writer owns the task worktree.
- `reviewing`: implementation is frozen for an independent review.
- `repairing`: the implementer is addressing concrete findings.
- `integrating`: reviewed work is being applied and checked against the current integration base.
- `accepted`: required evidence and semantic acceptance are recorded.
- `needs_replan`: an implementation/review pair stalled or the contract must change.
- `blocked_external`: progress depends on missing information, authorization, or external state that the orchestrator cannot resolve.

These labels belong to the task ledger, not to any platform-level goal-status API. A local operational check may remain pending while all local code work is accepted. Do not describe pending live verification as a completed deployment.

When a worker crashes, times out, or disappears, inspect its worktree and last evidence before reassigning. Do not assume its partial output was integrated. On orchestrator restart, reconcile the ledger with actual commits, active workers, and worktrees. Persist the accepted revision before enabling dependent tasks.

## 3. Dispatch packet

Every worker receives a self-contained packet, even if the harness supports conversation inheritance:

```json
{
  "taskId": "N06",
  "specVersion": 1,
  "goal": "Persist poll ownership and publication state so restart cannot duplicate daily news",
  "requirements": ["R01", "R02", "R06", "R07", "R08"],
  "baseRevision": "<accepted integration commit>",
  "worktree": "<absolute task checkout>",
  "dependencies": { "N01": "<accepted revision>", "N05": "<accepted revision>" },
  "ownedPaths": ["src/news/mongo.ts", "tests/news/outbox.integration.test.ts"],
  "sharedFileOwner": "orchestrator",
  "context": ["NEWS_IMPLEMENTATION_PLAN.md#n06--durable-poll-coordination-and-delivery-outbox"],
  "acceptanceExamples": [
    "Concurrent daily reservations produce one subscription/date publication",
    "A successful 20:00 collection suppresses fallback even while Discord is unavailable"
  ],
  "requiredChecks": ["pnpm format", "pnpm check"],
  "exclusions": ["No AI accounting changes", "No live Discord writes"],
  "handoffDirectory": "<local task artifact directory>"
}
```

The actual packet includes the entire card's acceptance cases, not only these examples. Supply the user requirements directly or provide accessible repository documents containing them. Evidence must describe current code, not only the earlier architecture proposal.

Use fresh context for reviewers. In the current collaboration tools, that means `spawn_agent` with `fork_turns: "none"` and an explicit contract/worktree/revision packet. Implementers may inherit relevant history when it saves substantial repeated investigation; a concise packet is preferable when the parent history is mostly unrelated. Keep the model choice inherited unless task evidence or user instructions justify a different choice. Do not invent unsupported tool modes or assume a framework is installed.

## 4. Worker prompts

### Explorer

> Read the task contract and inspect the current repository at the supplied base revision. Answer the stated uncertainty only. Identify relevant files/symbols, existing behavior, test patterns, required interfaces, and concrete failure cases. Separate observed facts from proposed choices. Use primary online sources only when current external behavior must be checked. Do not edit production code, install packages, send external messages, or spawn more agents. Return a concise context packet with file references and any contract issue that the orchestrator must resolve. Stop when the implementer has enough evidence to proceed.

Exploration output should normally fit on one or two pages. Link to fixtures or source evidence rather than pasting entire files. The implementer still verifies critical claims against its assigned base.

### Implementer

> Implement this task's user-visible outcome in the assigned worktree. Read the contract, repository instructions, accepted dependency interfaces, and context packet. Use concise functional patterns and the repository's package manager. Own only the assigned files; propose shared-contract changes to the orchestrator before making them. Write tests for meaningful behavior and failure modes. Run `pnpm format`, then `pnpm check` after the final edit, and `pnpm build` where required. Do not weaken tests or coverage gates. Return the exact diff/revision, requirement evidence, check results, and remaining uncertainty. Freeze the worktree for review. Do not declare the whole feature complete or perform external rollout actions.

When a task lacks context, the implementer can inspect locally or ask for a bounded explorer. It does not need an explorer merely to read a known file. Keep the same implementer for repairs while its context remains useful.

### Independent reviewer

> Review the assigned immutable diff against the original task contract and relevant surrounding code. Begin from the requirements, not the implementer's explanation. Read the implementation and tests, run focused verification where needed, and look for omissions, integration errors, incorrect state transitions, permission mistakes, and unsupported assumptions. Do not modify the implementation or use live Discord channels. Each blocking finding needs a requirement ID, file/symbol, concrete failure example or reproducible evidence, and expected behavior. Distinguish bugs from optional preferences. Report what was and was not verified. A passing test suite is evidence, not a substitute for checking the requirement.

The reviewer receives changed files, commit/diff identity, task contract, dependency interfaces, and check evidence. It does not receive a persuasive implementation transcript or a requested conclusion. Initial review context is fresh. Re-review may reuse the reviewer's context to track findings; final feature acceptance uses a fresh evaluator.

### Orchestrator acceptance

> Verify that the integrated behavior fulfills the original user request. Check the accepted requirements and review dispositions, inspect the actual integrated diff, and execute representative end-to-end cases. Confirm no out-of-scope changes, weakened gates, unresolved blocking findings, or stale review evidence remain. Record the integrated revision, relevant checks, and semantic acceptance evidence. Only then mark the task accepted and release dependents. If the result is correct in isolation but wrong after integration, return a concrete repair task to the responsible implementer.

## 5. Evidence formats

An implementation receipt records:

```json
{
  "taskId": "N06",
  "baseRevision": "<commit>",
  "headRevision": "<commit or snapshot>",
  "diffHash": "<hash including new/untracked task files>",
  "requirements": { "R08": ["test path and scenario", "relevant symbol"] },
  "checks": [
    {
      "command": "pnpm check",
      "exitCode": 0,
      "revision": "<same snapshot>",
      "artifact": "<sanitized log>"
    }
  ],
  "changedFiles": ["src/news/mongo.ts"],
  "limitations": [],
  "contractChangesRequested": []
}
```

Use actual values. Never fabricate a revision or check result. A bare `git diff` omits untracked files; include them in the review snapshot or make a local task commit after checking ownership. A review covers exactly one snapshot. Any subsequent code or formatting change that affects the diff requires refreshed evidence.

A review receipt records:

```json
{
  "taskId": "N06",
  "reviewedRevision": "<same snapshot as receipt>",
  "verdict": "changes_requested",
  "findings": [
    {
      "id": "N06-F1",
      "severity": "blocking",
      "requirement": "R08",
      "location": "src/news/mongo.ts:claimPublication",
      "scenario": "A sending lease expires after Discord accepted the message",
      "observed": "The implementation requeues it as pending",
      "expected": "Hold as uncertain until its result is established",
      "evidence": "<test or trace>"
    }
  ],
  "verified": ["<specific cases>"],
  "notVerified": ["<specific limits>"]
}
```

A finding is blocking when it violates a requirement, creates a material regression, risks duplicate/unauthorized delivery, or invalidates the evidence. Suggestions about names or style are non-blocking unless they violate an explicit repository standard. Do not require a reviewer to invent findings to demonstrate effort.

For every finding, the implementer returns `fixed`, `disputed`, or `needs_contract_decision`, with evidence. A fixed finding points to a regression test and new revision. A dispute explains why the failure case is impossible or outside the accepted contract. The reviewer verifies the disposition; the orchestrator resolves specification disagreements. Reviewer approval is not authority to expand scope or change user preferences.

## 6. Loop and stopping rules

The following is orchestration pseudocode, not an executable script bundled into the bot:

```text
load plan, ledger, repository instructions, and actual worktree state
reconcile previous workers and revision-bound receipts
while local implementation acceptance is incomplete:
    choose ready tasks whose dependencies are accepted
    allocate independent worktrees and non-overlapping ownership
    obtain targeted exploration only where context is missing
    dispatch implementation with the complete task packet
    collect implementation receipts and verify deterministic gates
    freeze the candidate; dispatch an independent reviewer
    while blocking findings remain and repair rounds < 2:
        return findings to the assigned implementer
        obtain the repaired revision and new check evidence
        ask the reviewer to verify dispositions and affected behavior
    if unresolved:
        mark needs_replan; inspect the failure; split, clarify, or reassign
        continue useful independent work
    integrate sequentially into the accepted base
    check the integrated diff and representative requirement scenarios
    if integration changed the reviewed behavior:
        obtain focused repair/review and rerun affected gates
    record acceptance; update ledger; release dependent tasks
run fresh feature-level acceptance and final required checks
produce local completion evidence and a separate live-verification status
```

The two-round limit bounds a stalled pair, not the entire feature. After two rounds, the orchestrator investigates the cause: unclear requirement, bad seam, missing fixture, incorrect reviewer finding, environmental failure, or insufficient worker context. It may split the task, commission a focused explorer, or assign a replacement implementer. Do not keep the same pair repeating an unchanged failure indefinitely.

No progress is an escalation signal, not a success condition. Do not automatically ask the user when code or tests can resolve the uncertainty. Ask only when a material product choice, unavailable information, or authorization is truly needed; preserve the question in the ledger while independent tasks continue.

A hard external block never becomes `accepted`. If only live verification lacks an authorized environment, finish local work and report that distinction. Do not automatically deploy, post to Discord, publish a PR comment, or change production credentials as a side effect of task completion.

## 7. Parallelism and integration discipline

Start with at most two implementation writers and a small number of useful read-only agents. The source adapters can be built in parallel after their contracts are fixed. Store/schema wiring, package manifests, command registration, and startup integration need a single owner. Separate worktrees prevent filesystem collisions; they do not prevent incompatible design decisions.

Each task worktree starts from accepted dependencies, not an arbitrary stale branch. The orchestrator provides absolute paths and checks that the worker is actually using them. Do not share uncommitted runtime files between writers. If only a shared checkout is available, serialize writes, installations, formatting, and other mutations. Read-only reviews may continue against a frozen snapshot.

The orchestrator integrates task commits/patches sequentially. Resolve conflicts deliberately and treat changed behavior as new work needing verification. Never overwrite user edits or apply broad resets. Before running repository-wide formatting in the integration checkout, confirm no other writer is active there.

Use a dedicated integration worker when integration itself becomes substantial; the orchestrator still owns the acceptance decision. Workers do not recursively spawn teams. Direct reviewer-to-implementer messages are allowed for fast clarification, but findings and resulting revisions must also reach the orchestrator and persistent records.

## 8. Final acceptance and measurement

N10's independent evaluator checks the full user journey from command configuration through scheduled source collection, durable planning, delivery, and restart. The orchestrator verifies the result against R01–R10. Passing source-parser tests while commands or the scheduler remain unwired is not feature completion.

Run `pnpm format`, `pnpm check`, and `pnpm build` after the final integrated code change. Record failures and pre-existing skips accurately. Do not repeatedly rerun unchanged expensive checks once they pass without a new reason. Read-only smoke tests and explicit live Discord checks are separate from offline regression gates.

Track task duration, repair rounds, substantive findings, recurring failure causes, integration conflicts, stale handoffs, and actual agent/token cost when the harness exposes it. Use those observations to reduce unnecessary exploration/review overhead or add investigation where it catches real defects. Do not invent measurements or interpret all extra agents as improved quality.

The final handoff includes the implementation revision, commands and behavior, acceptance matrix, check results, known limitations, deployment/activation instructions, and live-verification status. The user should be able to review or resume the work without reading every agent conversation.
