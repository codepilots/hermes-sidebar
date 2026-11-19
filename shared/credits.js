/* Third-party code bundled in this extension (vendor/), for the About section of the
   settings page. Each entry's licence text ships in vendor/ and is shown on request;
   versions match vendor/README.md. Update both when a bundle is rebuilt. */
const CREDITS = [
  { name: 'marked', version: '18.1.3', use: 'Markdown rendering of replies and the note preview',
    license: 'MIT', copyright: '© 2018+ MarkedJS; © 2011-2018 Christopher Jeffrey',
    url: 'https://github.com/markedjs/marked', file: 'vendor/LICENSE.marked' },
  { name: 'DOMPurify', version: '3.4.17', use: 'Sanitizing rendered Markdown',
    license: 'Apache-2.0 (dual-licensed MPL-2.0 OR Apache-2.0; used under Apache-2.0)', copyright: '© Cure53 and other contributors',
    url: 'https://github.com/cure53/DOMPurify', file: 'vendor/LICENSE.dompurify' },
  { name: 'highlight.js', version: '11.12.0', use: 'Syntax highlighting in code blocks',
    license: 'BSD-3-Clause', copyright: '© 2006 Ivan Sagalaev',
    url: 'https://github.com/highlightjs/highlight.js', file: 'vendor/LICENSE.highlightjs' },
  { name: '@arcjet/redact', version: '1.15.0 (with @arcjet/redact-wasm)', use: 'Detecting personal data (email, phone, card, IP) for redaction',
    license: 'Apache-2.0', copyright: 'Arcjet',
    url: 'https://github.com/arcjet/arcjet-js', file: 'vendor/LICENSE.arcjet-redact' },
  { name: 'compromise', version: '14.19.0 (with efrt, suffix-thumb)', use: "Finding people's names for redaction",
    license: 'MIT', copyright: '© Spencer Kelly',
    url: 'https://github.com/spencermountain/compromise', file: 'vendor/LICENSE.compromise' },
  { name: 'CodeMirror 6', version: 'state 6.7.6, view 6.43.15, commands 6.11.1, language 6.13.1, lang-markdown 6.5.2, search 6.7.2',
    use: 'The note editor (with style-mod, w3c-keyname, crelt and @marijn/find-cluster-break)',
    license: 'MIT', copyright: '© Marijn Haverbeke and others',
    url: 'https://codemirror.net', file: 'vendor/LICENSE.codemirror' },
  { name: 'Lezer', version: 'common, highlight, lr, markdown', use: 'Parsing Markdown in the note editor',
    license: 'MIT', copyright: '© Marijn Haverbeke and others',
    url: 'https://lezer.codemirror.net', file: 'vendor/LICENSE.lezer' },
  { name: 'diff-match-patch', version: '1.0.5', use: 'Merging note edits and highlighting changed lines',
    license: 'Apache-2.0', copyright: '© Google (original library); npm package by JackuB',
    url: 'https://github.com/JackuB/diff-match-patch', file: 'vendor/LICENSE.diff-match-patch' },
];

const PROJECT = {
  name: 'Hermes Sidebar', license: 'MIT', copyright: '© 2026 Autumn Thomson',
  repos: [
    { label: 'hermes-sidebar', url: 'https://github.com/codepilots/hermes-sidebar', what: 'this extension' },
    { label: 'hermes-outrigger', url: 'https://github.com/codepilots/hermes-outrigger', what: 'the Hermes gateway plugin it connects to' },
  ],
  hermes: { label: 'Hermes Agent', url: 'https://github.com/NousResearch/hermes-agent' },
};
