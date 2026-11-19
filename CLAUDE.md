# Agent rules — Hermes Sidebar

## Audit hub
`AUDIT.md` is the single audit map: trust boundaries, entry points → controls → sinks,
key workflow/boundary diagrams, and the security-sensitive units. Read it before
changing any security-sensitive code. Every security module carries an inline
`Audit: see AUDIT.md#<section>` header comment pointing at its section.

## Release is gated on documentation freshness
The `docs-audit` CI check must pass before merge (it is a required status check, along
with `test`):
- every `AUDIT.md` `file:line` anchor resolves to real code (code that moves breaks the
  anchor — update the doc in the same PR);
- every mermaid diagram renders;
- no overclaim words on the shipping surfaces (AUDIT.md, shared/README.md, manifests);
- every security-sensitive module keeps its inline AUDIT.md pointer.

`shared/docs/security-review.md` is frozen evidence (a dated review + runtime
verification record) and is exempt from the overclaim gate — do not rewrite it to
satisfy the gate; append new dated records instead.

## Changing a security-sensitive unit
Any change to the approval gate, grants, redaction, sanitization, credential policy,
Origin stripping, or the in-page agent MUST update its AUDIT.md section and diagrams in
the SAME PR, and keep claims honest: a claim about enforcement names the config that
enables it (default vs opt-in). Do not assert enforcement the default config does not
provide. Behavior changes to the approval decision must update the reference matrix in
tests/tool-gate.test.mjs deliberately, with the decision recorded in the PR.

## Refactor vs remediate
Readability refactors are behavior-preserving and separate from security fixes. Never
mix a refactor with a security fix in one diff. Security findings go through their own
branch and review.

## Build and test
`node build.mjs` builds both browsers into `dist/` (gitignored). Unit tests:
`node --test tests/tool-gate.test.mjs tests/outrigger-policy.test.mjs` (no dependencies
beyond Node). Runtime validation recipes live in the browser-extension-porting skill.
