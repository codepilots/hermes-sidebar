#!/bin/sh
# Rebuild vendor/arcjet-redact.js: @arcjet/redact is ESM-only across several files,
# so it is bundled into one IIFE exposing `ArcjetRedact.redact`. The Wasm is inlined
# by the package itself as base64 data: URLs (no network). Run from the repo root.
set -eu
tmp=$(mktemp -d)
cd "$tmp"
printf '{"name":"redact-build","private":true}\n' > package.json
npm install --silent --no-audit --no-fund --ignore-scripts \
  @arcjet/redact@1.15.0 @arcjet/redact-wasm@1.15.0 esbuild@0.28.2
printf 'export { redact } from "@arcjet/redact";\n' > entry.mjs
./node_modules/.bin/esbuild entry.mjs --bundle --format=iife --global-name=ArcjetRedact \
  --target=chrome120 --legal-comments=inline --outfile=arcjet-redact.js
cd - >/dev/null
cp "$tmp/arcjet-redact.js" vendor/arcjet-redact.js
rm -rf "$tmp"
