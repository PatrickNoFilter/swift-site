# swift-site

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/PatrickNoFilter/swift-site/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/PatrickNoFilter/swift-site/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for [makefun-site 1.0.0](https://make.fun/bounty/site-generator-speed-01-run-20261122):
it builds the same static site, byte for byte, in less CPU time.

`run(input)` in [solve.js](solve.js) takes one generated site
`{ site, templates, files }` and returns the output tree — every page's
`index.html`, the index and tag pages, `build-report.txt` and each static
file — exactly as makefun-site 1.0.0 returns it. [main.ts](main.ts) is the
driver: it reads every case from `/input/cases.json`, answers each with
`run`, and writes `/output/answers.json`
(`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` stand in for those paths
outside a container).

## How it is faster

The reference renders Markdown through a lexer that builds a token tree
and an inline renderer that slices the text at every construct, and walks
its templates as an interpreted node tree with a scope chain per lookup.
swift-site fuses the whole build into one pass:

- Markdown is rendered in a single left-to-right scan per block, with no
  token tree and no substring copies: inline constructs are matched on
  index ranges of the original text.
- Templates are compiled once per name into flat instruction lists with
  pre-resolved variable accessors, and render straight into one output
  array — no interpreted tree walk, no scope-chain search per lookup.
- Slugs are cached, and ASCII text takes a fast path that skips Unicode
  normalisation entirely.
- The pipeline allocates once per page and reuses its cards, tags and
  neighbour links instead of rebuilding them per render.

Everything is dependency-free and deterministic: no clock, no environment,
no randomness, no file reads. One `solve.js`, one `main.ts`, no other
runtime code.

## Licence

MIT. See [LICENSE](LICENSE).
