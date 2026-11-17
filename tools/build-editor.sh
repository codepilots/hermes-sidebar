#!/bin/sh
# Rebuild vendor/editor.js (Notebook mode): a minimal CodeMirror 6 (state, view,
# commands, language, Markdown only, search) plus diff-match-patch, bundled into one
# IIFE exposing `HermesEditor`. --before pins every package, transitive ones
# included, to releases at least two weeks old at build time. Run from the repo root.
set -eu
BEFORE=${BEFORE:-2026-11-03}
tmp=$(mktemp -d)
cp tools/editor-entry.mjs "$tmp/entry.mjs"
cd "$tmp"
printf '{"name":"editor-build","private":true}\n' > package.json
npm install --silent --no-audit --no-fund --ignore-scripts --before="$BEFORE" \
  @codemirror/state @codemirror/view @codemirror/commands @codemirror/language \
  @codemirror/lang-markdown @codemirror/search diff-match-patch esbuild@0.28.2
./node_modules/.bin/esbuild entry.mjs --bundle --minify --format=iife --global-name=HermesEditor \
  --target=chrome120 --legal-comments=eof --outfile=editor.js
cd - >/dev/null
cp "$tmp/editor.js" vendor/editor.js
rm -rf "$tmp"
