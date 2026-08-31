# AGENTS.md

## Golden rule: build when done

Always finish a change with a fresh build before handing it back:

```sh
bun run build
```

Pi loads and publishes the compiled bundle in `dist/` — not `src/`. Tests run
against `src/`, so green tests alone are not enough: without a build the
change is invisible in the TUI and unpublished. Rebuild so the user can
verify immediately.

## Before committing

```sh
bun run check
```

This runs typecheck, build, the full test suite, and dead-code lint. Keep it
green; a build alone is not completion.

## Package manager

This repo is bun-managed (`bun.lock`; scripts invoke `bun run` internally).
Do not use pnpm/npm — pnpm's pre-run dependency check fails against the bun
lockfile.

## Commits

Use conventional commits (commitlint): `feat(scope): ...`, `fix(scope): ...`,
`chore(release): <version>` for version bumps.
