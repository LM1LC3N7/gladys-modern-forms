# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Modern Forms and WAC smart
ceiling fans (generations 1 to 3): a Node.js service (Node 22+, ESM, no build
step) in its own sandboxed Docker container, talking to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency, and to the fans through their local HTTP API
(`POST /mf`, JSON).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/off.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npx github:GladysAssistant/integration-store .   # store admission checks
node scripts/cover.mjs cover.png          # the store cover (dev only)
```

## Architecture

```
index.js              SDK wiring only: handlers registered before connect()
src/handlers.js       the SDK handlers, shared with the tests
src/app.js            App: lifecycle, /data, pace, identity, Offs (guards),
                      commands, Discover, status, test button
src/fan/http.js       one HTTP request: bounded, deadline, cut, settles once closed
src/fan/client.js     the lane of one address (one request at a time, priorities)
src/fan/model.js      what the answers mean, what a command writes (pure)
src/devices.js        a fan -> its Gladys device (pure)
src/publisher.js      states within the Gladys rate limit
src/store.js          /data: pace, pauses, fan addresses, guards
src/config.js         DEFAULTS (mirror the manifest) + normalization
src/constants.js      API, features, limits, timings
src/i18n.js           French and English texts
test/helpers/         fake fans on the virtual clock, app setup
test/kit/             parts of the shared test kit (clocks, HTTP server)
```

Safety rules (see TODO.md "Decisions"): Offs (fan speed 0, light 0,
brightness 0) are protective: never refused by a pause, a queue, a read or the
configuration not read (address known); they cut the request in flight, are
kept in /data and sent again by a 10 s probe and by the reads (3 tries at
most, a try being an answer of the fan still showing the part on). Every
other command reads the fan first and goes only if that read shows the fan of
the device. Success only on the state answered. One request per fan at a time.
/data is read and written within 1.5 s or treated as unreadable / not written
(never a wait that holds an Off).

## Rules

- **External ids are forever** (`ext:<selector>:fan:<12 hex of clientId>`,
  feature keys `fan-speed`, `direction`, `wind`, `light`, `brightness`).
- **A device never drives another fan**: commands check the `clientId` read.
- **Never read nor keep `owner` / `federatedIdentity`** of the information
  answer (the e-mail of the app account).
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow**; `test/manifest.test.js` checks
  they agree.
- **Changelog** under `## [Unreleased]`.
- **Manifest texts** are `{ "en", "fr" }`; user-facing text is bilingual.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network beyond 127.0.0.1.
