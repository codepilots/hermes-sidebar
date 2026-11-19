#!/usr/bin/env python3
"""Audit-hub freshness gate for hermes-sidebar (refactor-for-human-audit).

Hard gate (exit 1 on any failure):
  1. every `path:line` / `path:start-end` anchor in AUDIT.md resolves to a real
     file and line range — code that moved/renamed breaks the anchor, forcing
     the doc to be updated (the mechanical freshness trick).
  2. each security-sensitive module carries an inline 'Audit: see AUDIT.md'
     pointer, so the hub link cannot silently disappear.

Overclaim words on the SHIPPING PROSE surfaces are fatal (--strict-overclaim in CI).
Manifests are machine configuration, not prose: their CSP literals contain 'safe'
('wasm-unsafe-eval' — a security-critical keyword that must not be reworded), so they
are out of the glob; their one-line descriptions were claims-passed manually.
Frozen evidence (shared/docs/security-review.md) is deliberately NOT in DOC_GLOBS:
it is a dated review/verification record, claims-passed at its own release.

Optional: --extract-mermaid DIR writes each ```mermaid block to DIR/*.mmd so CI
can render them with @mermaid-js/mermaid-cli (mmdc).
"""
import argparse
import re
import sys
from pathlib import Path

AUDIT_PATH = "AUDIT.md"
SECURITY_MODULES = [
    "shared/tool-gate.js",
    "shared/panel.js",
    "shared/browser-tools.js",
    "shared/redactor.js",
    "shared/markdown.js",
    "shared/page-agent.js",
    "shared/outrigger.js",
    "shared/options.js",
    "chrome/platform.js",
    "firefox/platform.js",
    "shared/background-common.js",
    "shared/api-shim.js",
]
DOC_GLOBS = ["README.md", "AUDIT.md", "shared/README.md"]
OVERCLAIM_WORDS = ["enforced", "prevents", "cannot", "safe", "guarantee", "provably"]

ANCHOR_RE = re.compile(r"([A-Za-z0-9_./-]+\.(?:py|js|mjs|ts|tsx|jsx|go|rs|rb|java|c|cpp|h|yaml|yml|json|toml|md)):(\d+)(?:-(\d+))?")
POINTER_RE = re.compile(r"Audit:\s*see\s+AUDIT\.md", re.IGNORECASE)
MERMAID_RE = re.compile(r"```mermaid\n(.*?)```", re.DOTALL)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audit", default=AUDIT_PATH)
    ap.add_argument("--extract-mermaid", metavar="DIR")
    ap.add_argument("--strict-overclaim", action="store_true")
    args = ap.parse_args()

    audit = Path(args.audit)
    if not audit.exists():
        print(f"FAIL: {audit} missing — the audit hub must exist")
        return 1
    text = audit.read_text(encoding="utf-8")
    failures = 0

    # 1. anchor freshness
    seen = set()
    for m in ANCHOR_RE.finditer(text):
        path, start, end = m.group(1), int(m.group(2)), m.group(3)
        key = (path, start, end)
        if key in seen:
            continue
        seen.add(key)
        f = Path(path)
        if not f.exists():
            print(f"FAIL anchor: {path}:{start} — file missing (renamed/moved?)")
            failures += 1
            continue
        n = len(f.read_text(encoding="utf-8", errors="replace").splitlines())
        hi = int(end) if end else start
        if not (1 <= start <= hi <= n):
            print(f"FAIL anchor: {path}:{start}-{hi} — out of range (file has {n} lines)")
            failures += 1
    print(f"anchors checked: {len(seen)}")

    # 2. inline hub pointers in security modules
    for mod in SECURITY_MODULES:
        p = Path(mod)
        if not p.exists():
            print(f"FAIL pointer: security module {mod} missing")
            failures += 1
            continue
        head = "\n".join(p.read_text(encoding="utf-8", errors="replace").splitlines()[:40])
        if not POINTER_RE.search(head):
            print(f"FAIL pointer: {mod} has no 'Audit: see AUDIT.md#...' header comment")
            failures += 1

    # overclaim words on shipping surfaces
    overclaim = 0
    for glob in DOC_GLOBS:
        for f in Path(".").glob(glob):
            if not f.is_file():
                continue
            for i, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                low = line.lower()
                if any(w in low for w in OVERCLAIM_WORDS):
                    print(f"OVERCLAIM {f}:{i}: {line.strip()[:100]}")
                    overclaim += 1
    if overclaim and args.strict_overclaim:
        failures += overclaim

    # optional mermaid extraction for mmdc
    if args.extract_mermaid:
        out = Path(args.extract_mermaid)
        out.mkdir(parents=True, exist_ok=True)
        blocks = MERMAID_RE.findall(text)
        for i, body in enumerate(blocks):
            (out / f"block-{i}.mmd").write_text(body, encoding="utf-8")
        print(f"mermaid blocks extracted: {len(blocks)} -> {out}")

    print(f"\n{'FAIL' if failures else 'PASS'}: {failures} hard-gate problem(s); {overclaim} overclaim advisory line(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
