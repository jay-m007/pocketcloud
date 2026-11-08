# Pocketcloud

[![CI](https://github.com/jay-m007/pocketcloud/actions/workflows/ci.yml/badge.svg)](https://github.com/jay-m007/pocketcloud/actions/workflows/ci.yml)

Host the small tools you build for one person or one team. `pocketcloud deploy` a folder, get a private link, and
the app **goes to sleep when nobody uses it** and wakes on the next click.

```
$ pocketcloud deploy ./expense-bot
Deployed expense-bot (node, private) at http://expense-bot.localhost:8787
$ pocketcloud invite expense-bot --label ana
http://expense-bot.localhost:8787/__pc/join?t=…        ← send this to Ana; it signs her in
```

Zero runtime dependencies. One Node process plus your apps.

## Why

A dashboard for your team of four, a bot, a calculator for one client: they do not need autoscaling or a cluster, they
need a URL that only the right people can open and a bill close to zero. Pocketcloud keeps the whole idea small:
private by default, asleep when idle, one command to deploy.

## Quick start

Needs Node 22.18 or newer.

```
git clone https://github.com/jay-m007/pocketcloud && cd pocketcloud && npm install
node src/cli.ts serve                 # leave this running (apps open at http://<app>.localhost:8787)
node src/cli.ts deploy ./my-app       # in another terminal
```

(`npm run build` then `node bin/pocketcloud.js …` works too.) Chrome, Firefox and Safari open `*.localhost`
addresses without any DNS setup. For curl use `curl --resolve my-app.localhost:8787:127.0.0.1 …` or a Host header.

## What you can deploy

| Folder contains | How it runs |
|---|---|
| `package.json` with a `start` script, a `main` file, or `server.js`/`index.js`/`app.js` | `npm start` / `node <file>`; `npm install --omit=dev` runs on deploy if there are dependencies |
| `app.py`, `main.py` or `server.py` | `python3 <file>`; `requirements.txt` is installed into the app folder |
| `index.html` (or `{"static": true}` in `pocketcloud.json`) | served directly by Pocketcloud, no process at all |
| `pocketcloud.json` with `{"run": "<command>"}` | that command, for anything else |

Your app must listen on the port in the `PORT` environment variable. Put files you want to keep in the folder named by
`DATA_DIR`: it survives sleeping, restarts and redeploys. Everything else in the app folder is replaced on deploy.

## Commands

```
pocketcloud serve [--port 8787] [--host 127.0.0.1] [--domain localhost] [--scheme http|https]
pocketcloud deploy [dir] [--name app] [--public] [--idle 300] [--memory 256]
pocketcloud ls | logs <app> | stop <app> | rm <app>
pocketcloud invite <app> [--label ana] | invites <app> | revoke <app> <id>
pocketcloud token                      # admin token, for deploying from another machine
```

Settings stay with the app between deploys: pass a flag only to change it.

## How it works

- **One server, two jobs.** The server answers `http://<app>.<domain>:<port>` by proxying to that app, and answers
  `/__pc/api` (admin token) for the CLI.
- **Wake on request.** If the app is asleep, the first request starts it on a free port, waits until it accepts
  connections, then forwards. Requests that arrive at the same moment share one start.
- **Sleep when idle.** After `--idle` seconds with no request and no open connection (websockets count), the app is stopped.
  A crashed or never-listening app gives a readable error page with its last log lines.
- **Memory limit.** The server checks each running app's memory every few seconds and stops the ones over `--memory`
  (Linux). Node apps also get `--max-old-space-size` set.
- **Private by default.** `invite` makes a link containing a secret. Opening it sets a cookie for that app only; revoke
  it and the cookie stops working. Nothing reaches your app until a request passes this check, so a visitor without an
  invite cannot even wake it. The admin token and the session cookie are removed before a request reaches your app.

## Numbers

20 tiny Node apps on a 2-CPU Linux box, Node 22 (`node bench/run.ts`, raw output in `bench/results.json`):

| | |
|---|---|
| Cold start (first request to a sleeping app) | median **142 ms**, p95 189 ms |
| Warm request through the proxy | median 1.8 ms, p95 3.6 ms |
| Memory, 20 apps awake | about **1.2 GB** (about 57 MB per Node app) |
| Memory, 20 apps asleep | about **96 MB** (the server itself) |

These are small do-nothing apps. A real app with a database client or a framework starts slower and uses more.

## Security: read this

**The default runner is not a sandbox.** Apps run as ordinary processes under the user that started Pocketcloud, with a
scrubbed environment (no inherited secrets), their own home and data folder, a memory limit, and a process group that is
killed on sleep. They can still read files that user can read and use the network. Deploy only code you trust.

`POCKETCLOUD_RUNNER=docker` runs each app in a container instead (read-only filesystem, all capabilities dropped,
memory/CPU/process limits, only its code and data folders mounted). It is written against the Docker CLI but **has not
been run in CI**, because it needs a Docker daemon; treat it as untested.

Other things to know:
- Serving over the internet needs HTTPS in front (Caddy or nginx, with a wildcard DNS record such as `*.example.com`)
  and `--scheme https --domain example.com`. Pocketcloud does not do TLS itself.
- The invite link is a password. Anyone holding it can open that app until you revoke it.
- Uploads are limited to 50 MB, must not contain links, and are unpacked with path checks.

## Limits

- One machine. No clustering, no multi-region, no autoscaling beyond "asleep or awake".
- One running copy per app, so an app cannot use more than one process.
- Memory limits need Linux (`/proc`). On macOS and Windows apps are not memory-limited. Windows is untested.
- Dependencies install on the server at deploy time, so it needs network access then.
- No built-in database. Use files in `DATA_DIR` (SQLite works well) or connect to your own.
- Invites sign people in as "someone with the link": no accounts, no per-person logs.

## Develop

```
npm test           # 15 tests, offline; they start real servers and real apps
npm run typecheck
npm run bench
```

MIT licence. Built by Jay Maurya.
