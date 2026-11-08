# Pocketcloud

Self-hosted mini cloud for small software: `pocketcloud deploy` a folder, get a private URL; the app sleeps when idle and wakes on the next request.

## Commands
- `npm test`: offline test suite (node:test; starts real daemons on random ports)
- `npm run typecheck`: `tsc --noEmit`
- `node src/cli.ts serve`: start the daemon (default http://localhost:8787, apps at http://<name>.localhost:8787)
- `node bench/run.ts`: cold-start and memory numbers

## Code rules
- TypeScript run by Node's type stripping: no enums, namespaces or constructor parameter properties; use `import type` for types; relative imports end in `.ts`.
- Zero runtime dependencies. Use node: built-ins and the system `tar`.
- Never claim isolation the code does not provide: the process runner limits memory and scrubs the environment, it is not a sandbox. Say so in the README.
- Add a test for every new behaviour. Tests must not need the network.

## Git
- Commits are authored as Jay Maurya <maurya67jay@gmail.com>. Do not add co-author or "generated with" lines to commits or pull requests.
