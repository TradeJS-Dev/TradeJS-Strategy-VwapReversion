# AGENTS.md

## Scope

These rules apply to an independent TradeJS strategy repository.

## Workspace Routing

- Start from `~/dev/tradejs/AGENTS.md`; do not scan sibling repositories.
- Change this repository for VwapReversion source, tests, figures and package metadata.
- Run package checks here. Run operational backtests from `tradejs-project`.
- Do not change shared Project composition, runtime configuration or existing
  `node_modules` as part of package development. This repository uses Yarn PnP.
- Do not run optimization, training, publication or deployment without a new
  explicit request.

## Package contract

- Export `strategyEntries` from the package root.
- Every strategy entry must own a strict `parseConfig` implementation built
  from `@tradejs/strategy-kit/config` and covered by contract tests.
- Keep detector state replayable and bounded.
- Keep StrategyAPI side effects in strategy core code, outside pure engines.
- Import TradeJS APIs only through public package exports.
- Put strategy tests in this repository.
- Do not add Redis, exchange clients, deployment logic, production containers,
  credentials, or user configuration.
- Keep `@tradejs/strategy-kit` because the standard config contract consumes
  its public `config` subpath.
- A repository exports one strategy unless the central architecture catalog
  records a grouped exception.

## Verification

Run `yarn checks` before every commit.

## Runtime Dependency Contract

- Keep every `@tradejs/*` runtime package in both `peerDependencies` and `devDependencies`, never in `dependencies`.
- The consuming TradeJS Project must own the exact runtime composition; nested TradeJS package copies are forbidden.
- Keep the package-contract test in `yarn checks` whenever dependency metadata changes.
