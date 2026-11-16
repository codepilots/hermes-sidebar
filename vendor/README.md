Vendored, unmodified (Chrome extensions cannot load remote code):
- marked 18.1.3 (lib/marked.umd.js), MIT
- dompurify 3.4.17 (dist/purify.min.js), Apache-2.0 OR MPL-2.0
- @highlightjs/cdn-assets 11.12.0 (highlight.min.js, common languages), BSD-3-Clause
Fetched with npm pack (registry integrity checked) on 2026-11-16.
- @arcjet/redact 1.15.0 + @arcjet/redact-wasm 1.15.0, Apache-2.0: bundled by
  tools/build-arcjet-redact.sh (esbuild 0.28.2) into arcjet-redact.js; Wasm inlined
  as data: URLs by the package, no network. Needs 'wasm-unsafe-eval' in the CSP.
- compromise 14.19.0 (builds/compromise.js), MIT.
