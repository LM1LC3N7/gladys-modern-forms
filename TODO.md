# TODO - Modern Forms v1

Handoff document: what is done, what was decided, what comes next. Keep it up
to date at the end of every milestone.

## Status

- [x] **Milestone 1** (2026-10-31): generations 1 to 3 through `POST /mf`;
      fan speed (0 = off), direction, breeze (generation 3), light and
      brightness; Offs protective (guards in `/data`); identity by
      `clientId`; Discover; "Test the connection"; fr/en docs. Tested against
      fake fans on a virtual clock (built from the WAC reference and the mock
      fan of aiomodernforms) and a real local HTTP server on a real clock (x20).
- [x] **Review r1** (2026-10-31): REFUSÉ (4 importants, 6 mineurs); fixed: the
      probe of the Offs held (I1), the guard mutants (I2), a scene on one fan
      written at once (I3), each Off judged by the reads only, one resend per
      interval (I4), the temporary file of /data (m2), the 1 s cut of a frozen
      Off armed on the request running (m6), the Off after a swap not seen (m1,
      docs).
- [ ] **Next patch** (review r1 minors left): m3, a light detected from
      `lightOn` in the state (the WAC generation 3 example has `lightType: ""`
      with `lightOn`): use an empty `lightType` as a sign of no light kit once a
      real fan shows it; m4, `lightOn` + `lightBrightness` in one request (the
      flash of aiomodernforms issue #99: brightness first); m5, the follow-up
      reads (5 s, 20 s) not grouped: one pair per address, not per write.
- [ ] **Review** r2 (high), then release.
- [ ] **Milestone 2**: generation 4 (`/device` + `/fixture`, several light
      fixtures, color temperature), sleep timers, mDNS discovery
      (`_easylink._tcp`, `scanNetwork('mdns')`), Wi-Fi signal (`/config-read`).

## To check on a real fan

- That a command answers the whole state after it (WAC reference: "Response
  will be the dynamic shadow data, with the updated values"): the success of a
  command is read from it.
- Whether `fanSpeed` alone, `fanDirection`, `wind` or `lightBrightness` alone
  start a part that is off (here: a speed or a brightness is sent with
  `fanOn` / `lightOn` true; a direction or the breeze never lift an Off held).
- The flash of the light when `lightOn` and `lightBrightness` go in one
  request (aiomodernforms issue #99 splits them).
- That `clientId` is the station MAC on generation 3 (WAC reference, note on
  the MAC addresses in AP mode).
- A fan without light kit: no `lightOn` in its state (as the mock fan does).

## Decisions

- **Version 0.1.0, set by hand once** in `package.json`, `package-lock.json`,
  the manifest `version` and the `docker_image` tag; every later version comes
  from Actions > Release.
- **SDK 0.16.0** (the latest on npm on 2026-10-31, `^0.16.0`).
- **Own client, no dependency**: no maintained Modern Forms client on npm; the
  API is ported from aiomodernforms 0.3.1 (MIT, the library of Home
  Assistant), credited in `THIRD_PARTY_NOTICES.md` (copied into the image with
  `LICENSE`), and checked against the WAC reference of its repository.
- **Generations 1 to 3 only** in milestone 1: generation 4 is another API
  (`/device`, `/fixture`, light fixtures by address) whose read-all does not
  match its own document (aiomodernforms issue #287): left for later; its 404
  on `/mf` is said in the status.
- **Features**: `fan/speed` 0-6 (0 = off: Gladys has no on/off type in the fan
  category, and a speed slider with 0 is how Matter fans read); direction
  `fan/airflow-direction` and breeze `fan/wind-setting` with the values of the
  core and `supported_options`; light `light/binary` + `light/brightness`
  0-100 (0 = off). No `switch`: "turn every switch on" never starts a fan.
  Nothing sensitive (no heating, no water, no access): no option.
- **Not exposed**: sleep timers (generation 1-2 take an epoch of the fan's
  clock, not checked without a fan), schedule, away mode (starts the fan and
  the light by itself), adaptive learning, wind speed, pairing, reboot,
  factory reset, decommission. Only the 6 command fields above are ever
  written (`validBody`, right before the request leaves).
- **Identity**: the 12 hex digits of `clientId` (in every answer) are the
  platform id. A non-protective command reads the fan first (a read leaving
  after the click, shared by a scene) and is written only if it shows that
  fan at an address of the configuration; the answer of the write is checked
  again. An answer without a valid `clientId` publishes nothing and is no
  proof of another fan.
- **Probe of the Offs held**: an Off that never left, or whose last send was
  refused (429, 5xx) or got no answer, is sent again every 10 s whatever the
  pause of the reads (one per address, the others of that address right behind
  its answer), never given up: a refusal, a cut or no answer is no try; a
  resend counts only when the fan accepted it (2xx) and its answer still shows
  the part on (review r2, B1); the first send that ever leaves is no resend
  (`left`, in /data).
- **Only the reads judge an Off**, each on its own field (the answer of a write,
  of the other part or of a command, never does: review r1, I4, 3 resends
  burnt in 114 ms); one resend per read interval at most, the gate capped at
  10 s (review r2, m-a).
- **A scene on one fan**: the commands waiting that one read serves (they came
  before it left) are written together, each field once (the same value asked
  twice is one field), so 5 functions on a fan answering in 900 ms take one
  read and one write; each is judged on its own fields of the answer. A finished
  read that left after a command serves it too.
- **Offs** (fan speed 0, light 0, brightness 0): go to the address the fan was
  last read at in this session, else in this process, else in `/data`, else
  the `address` param of the device (upserted by Discover), else the only
  address typed; refused only when none is known, when another fan answered
  last there, or when a newer Off took their place. Never refused by a pause,
  the queue (they cancel the commands of the same part waiting and stop one
  taken from the queue before its first byte), a read in flight (cut), the
  configuration not read, /data (saved without waiting). Tried for 250 ms,
  then kept and sent as soon as the lane is free; resent by the reads that
  contradict them, 3 times at most, counted when they left (a try that never
  left is no try, an unreadable count is 0, no age limit). Confirmed by a
  read (or their own answer) showing the part off. Lifted by a newer command
  starting the same part that left (not a 4xx / 429 answer), another Off, the
  device deleted, or once confirmed by the part read on twice in a row
  (remote, app); never by the time. An older start of ours that may still land
  is not taken for a change elsewhere. At start, the unconfirmed ones leave
  before getConfig and before the first read. A fan read at a new address
  takes its Offs along.
- **One request at a time per address** (lane of gladys-ipx800 0.1.3):
  priorities Off clicked > Off resent > commands and their read > follow-up
  reads > polling. The answers are applied in the order their requests left.
- **Commands**: written by 3.5 s after the click or refused "nothing was
  sent"; the answer awaited until 4.3 s; the state answered decides: the value
  asked = success, the old one = "not applied yet", none = "sent, without
  confirmation"; reads 5 s and 20 s later.
- **Pace**: one read per interval per address (10 s, 5 to 300), the attempt
  put in `/data` before the read; failures 10 s, 30 s, 1, 2, 5 min, at least
  a minute on 429 / 503, the pause in `/data` (capped at an hour on read
  back). The information read (name, model) is secondary: at most once an
  hour, its failure never pauses nor blocks anything.
- **/data**: read and written within 1.5 s or unreadable / not written; an
  unreadable file is never written over until it reads again; only a plain
  file is read (FIFO, link, folder refused). Holds no name, no e-mail.
- **Configuration**: `fans` (up to 8 addresses), `poll_interval`, `language`;
  no secret. Configurations saved one after the other apply in order, the last
  one wins; a session restart keeps the lanes, the pace and the Offs.
- **Manifest**: categories `climate`, `lighting`; no `keywords` / `countries`
  yet (they need `gladys_version` >= 5.3.0).
