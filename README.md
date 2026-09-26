# Kinvue

Kinvue is a daily check-in that tells a **caregiver** when the older adult they look
after is having a day that is different from that person's own usual. Sit in front of a
camera for ~30 seconds → the Presage SmartSpectra SDK reads pulse, breathing and HRV
from the video → three or four short questions cover mood, sleep, food and pain → the
session is scored against that person's own baseline and surfaced on a caregiver
dashboard, with the reason it was flagged written out in plain language.

It is **not** a diagnosis tool and **not** an emergency alert system. It answers one
narrow question honestly: *does today look like their normal, and if not, what
specifically is different?*

This document is the entry point for both humans onboarding and AI agents contributing.
It should be enough to understand how the system fits together and where to make a change.

> **Project status: early.** Kinvue is a personal project, developed in the open with no
> deadline. **The loop closes as of KV-2**: a capture, four questions, a scored session on
> the dashboard, all on real hardware. The SmartSpectra capture has returned real pulse,
> breathing and HRV from a webcam (KV-1) — on one machine, in one room, which corrected
> several assumptions this code was built on. What the SDK sends to Presage has been
> measured (KV-65): a licence meter, not the video. Nothing here has been used by anyone it
> was built for.

---

## Tech Stack

| Layer | Stack |
|---|---|
| **app/main** | Electron 44 (Node 24) · owns the camera, the API key and the session file |
| **app/preload** | `contextBridge` · a named-call IPC surface, no generic passthrough |
| **app/renderer** | React 19 · Tailwind CSS v4 · TypeScript — the caregiver dashboard |
| **core/** | Framework-free TypeScript: baseline, rules, scoring, session types, demo seed |
| **Vitals** | [Presage SmartSpectra](https://smartspectra.presagetech.com/) `@smartspectra/node-sdk` v3 — camera-based pulse, breathing and HRV |
| **Data** | A single JSON file under Electron's `userData`. No server and no database of ours; the SDK itself calls out during a capture (KV-65) |
| **Build** | electron-vite 5 on Vite 7 · TypeScript 5.9 · Vitest · ESLint 10 |

**Why Electron and not a web app.** The SmartSpectra SDK ships no browser build — the
supported targets are Android, iOS, C++ and Node/Electron. The SDK binds a
platform-specific native runtime through `koffi` (FFI), so the capture has to live in a
Node process. The UI is still written as a web app; it just ships in an Electron shell.

---

## Architecture & Flow

Check-ins happen on one machine and stay there. The SDK itself talks to Presage while a
capture runs (KV-65); nothing else here opens a socket.

**A capture needs an internet connection.** Not a preference — measured: with the network
down a capture fails fast, as an error rather than a hang, and produces no reading at all —
including straight after a successful capture in the same launch. The SDK reports that as
`kProcessingFailed`, the same code a genuinely bad capture gets, so the app decides from
`net.isOnline()` instead and says so plainly rather than blaming the camera (KV-104).

**The video is not being uploaded.** Measured with Wireshark over two captures of
different lengths, one of each (KV-65), and confirmed in a second run of two captures in
one launch:

| | 28s capture | 50s capture |
|---|---|---|
| Sent to Presage | 55 kB | 66 kB |
| Received from Presage | ~2.05 MB | ~2.10 MB |

Uploading even heavily compressed 320px video for fifty seconds would be megabytes. 66 kB
is not that, and the traffic runs overwhelmingly *inwards*: about 2 MB is fetched at the
start of **every capture**, not once per launch, and nothing crosses between captures.

Why a capture cannot run offline is in the SDK's own log: offline, its metric authorization
fails ("Authorization server unavailable"), and then the model it loads for the capture
fails to load — most likely the 2 MB it would otherwise have fetched. Both a licence check
and a model load stand in the way. See ARCHITECTURE.md for what that means for offline use
later.

What is sent does **not** grow like a stream of readings. Nearly doubling the capture length
raised outbound by a fifth, and the growth is all in short connections that each carry about
the same ~2.1–2.2 kB whatever the length — about a TLS handshake plus a small request, since
the SDK opens a fresh connection every five seconds, and another every fifteen, rather than
reusing one. A payload that grew with the measurement would not hold steady like that.

**What those pings carry is a licence meter.** The runtime's compiled-in endpoints are
device-key registration and rotation, metric authorization, and usage sync — and its only
upload-shaped message reports session start and end times plus, per metric, a datapoint
count, an output frequency and a precision. Counts and timings: *how much* was measured,
never *what*.

That was read out of the shipped runtime's own schema rather than by decrypting the
traffic, so the honest limit is this: no measurement-upload schema exists in the binary,
and the traffic volume matches a meter rather than a stream. Two independent lines of
evidence agreeing is as far as this goes without asking Presage directly.

```
                     ┌──────────────────────────────────────────┐
  the cared-for      │  app/renderer  (React, no node access)   │
  person sits here   │  check-in questions · caregiver dashboard│
        │            └────────────────┬─────────────────────────┘
        │                             │  named IPC calls only
        ▼                             │  (app/preload — no generic invoke)
   ┌─────────┐                        ▼
   │ webcam  │───────────►  app/main  ── owns API key, camera, session file
   └─────────┘                 │
                               ├─ 1. captureVitals()          (app/main/vitals.ts)
                               │     SmartSpectra SDK, ~30s
                               │     → pulse · breathing · HRV + confidence
                               │
                               ├─ 2. answers from the renderer (mood/sleep/food/pain)
                               │
                               ├─ 3. scoreSession(session, history)   (core/scoring)
                               │     ├─ computeBaseline(history)      (core/baseline)
                               │     │    this person's own trailing 14 sessions
                               │     ├─ run every rule                (core/scoring/rules.ts)
                               │     └─ sum severities → normal | elevated | insufficient-signal
                               │
                               └─ 4. append to sessions.json          (core/session/store.ts)
                                     └─► dashboard re-reads and renders the explanation
```

The session being scored is **never** part of the baseline it is compared against.

---

## Repository Layout

```
app/
  main/
    index.ts             Electron entry: window, IPC handlers, store wiring
    device.ts            what the device can honestly say about its time zone
    frames.ts            camera frames → a small picture a screen can show
    env.ts               loads .env into process.env before anything reads it
    vitals.ts            SmartSpectra capture → one Vitals object   ← KV-1, highest risk
  preload/
    index.ts             contextBridge surface. The API key never crosses this line.
  shared/
    capture-reply.ts     how a capture crosses IPC, so a pressed Stop is not logged as
                         a fault (KV-89). Main and preload both use it; no Electron here
  renderer/
    index.html           CSP: default-src 'self' — the UI loads nothing off the
                         network. img-src also allows blob:, for the self-view.
    App.tsx              caregiver dashboard shell
    components/
      CaptureScreen.tsx  the ~30s in front of the camera (settable) — the one screen the
                         cared-for person reads, not the caregiver
      QuestionFlow.tsx   the four questions, also addressed to them
      SessionCard.tsx    one check-in: readings, every answer, the rules that fired
    styles.css           Tailwind v4 theme tokens

core/                    Plain TypeScript. No Electron, no React — unit-testable.
  session/
    types.ts             Vitals, CheckInAnswers, FiredRule, Assessment, SessionRecord
    store.ts             JSON session store (MAIN PROCESS ONLY — imports node:fs)
    validate.ts          runtime checks on everything the renderer sends to main
    answers.ts           the four questions: complete, or not a check-in at all
    checkin.ts           holds a capture until its answers arrive, then scores and stores it
    time.ts              which local day a check-in belongs to, where it was taken
  baseline/index.ts      per-person trailing baseline + MIN_BASELINE_SESSIONS
  scoring/
    rules.ts             every rule, each independently testable
    index.ts             the engine: severity sum → flag + explanation
  capture/guidance.ts    which of the camera's hints are worth showing the person
  capture/failure.ts     telling apart the ways a check-in fails to happen
  seed/persona.ts        the demo persona's invented history (KV-8, disclosed)

tests/                   Vitest. Covers baseline, scoring, validation, check-in, time,
                         device, guidance, frames, answers, failures, the capture reply,
                         vitals and env.
```

---

## Key Concepts (read these before changing scoring)

- **The baseline is the person, never a population.** Comparing an 82-year-old's resting
  pulse to a textbook range produces a dashboard that cries wolf every morning. Comparing
  it to their own trailing fortnight is the thing a caregiver cannot do by eye, and it is
  the only comparison this app makes.
- **The explanation is the product, not a debugging aid.** A flag without the numbers
  behind it is a black box asking a family member to worry. Every rule that fires carries
  a plain-language sentence naming the actual values, and `firedRules` is rendered even
  when the verdict is `normal` — "normal, and here are the two things that did register"
  is more trustworthy than a bare green tick. Pulse and breathing are compared in both
  directions, below their usual as well as above, at the same thresholds (KV-9). The
  z-rules also say how far out the reading is, because "75 bpm, above their usual 72"
  reads as trivially true when the point is that three beats is a lot *for them*;
  `hrv-drop` carries no such clause, since a percentage already carries its own
  magnitude. They quote a spread only when one was measured — never the
  `MIN_SD_FRACTION_OF_MEAN` floor, and never a real spread rounded down to "about 0" —
  because a number nobody produced is worse than saying plainly that there is nothing to
  measure the difference against.
- **A baseline only contains captures the scorer would use.** A capture withheld as
  `insufficient-signal` — nothing measured, cut short, unrated, or rated below
  `MIN_CAPTURE_CONFIDENCE` — never becomes part of "their usual", and never counts toward
  the check-ins a caregiver is told they are still waiting for. `computeBaseline` filters
  on the same `unusableReason` the scorer gates on, which is why that predicate lives in
  `core/session/usable.ts` rather than in either of them. Declining to show a number on
  one card and quoting it as normal on the next is one failure, not two.
- **Rules, not a trained model — on purpose.** There is no labelled dataset of "days
  before an older adult got ill", and a model trained on synthetic data would be a
  confident guess dressed as evidence. See `ARCHITECTURE.md`.
- **`insufficient-signal` is a real answer.** A poor camera reading, a capture cut short,
  or a baseline that is still building all produce a withheld verdict rather than a
  cheerful green. So does a metric measured at the check-in with too few readings of its
  own to have a usual: "Looks normal" would claim a comparison that did not happen, so a
  would-be `normal` is withheld and the card names the metric. An `elevated` verdict
  stands and names it too (KV-87). Scoring the answers alone and calling it `normal`
  would misrepresent what was actually measured.
- **Missing is not zero.** A metric the SDK never reported with usable confidence stays
  `null` through the whole pipeline. A reading of zero and no reading at all must never
  look alike to a rule.
- **Severity is not risk.** The 0..1 severity on each rule exists only to order and
  combine rules against `ELEVATED_SEVERITY_THRESHOLD`. It is not a probability, it is not
  calibrated against outcomes, and it must not be shown to a caregiver as a score.

---

## Local Development

Needs Node `^22.22.2 || ^24.15.0 || >=26.0.0` (`engines` in `package.json`) — the range
every dependency supports, jsdom 30 setting the floor on 22 and 24. Node 20 cannot run
the test suite. CI uses 24, and Electron 44 itself runs 24.21.

```bash
npm install

# 1. Get a free SmartSpectra API key
#    https://physiology.presagetech.com/auth/register
cp .env.example .env         # then paste the key into SMARTSPECTRA_API_KEY

# 2. Run the app (Vite dev server + Electron, hot reload on the renderer)
npm run dev
```

Checks — these four are exactly what CI runs:

```bash
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm test             # vitest, node environment; seconds warm, longer on a cold start
npm run build        # electron-vite build
```

`npm test` needs neither a camera nor an API key: `core/` is deliberately free of
Electron and React imports, so the rules are testable in a plain node environment. That
separation is load-bearing — keep Electron out of `core/`.

Without a key, `npm run dev` starts and the dashboard renders, but pressing capture
throws `MissingApiKeyError`. That is deliberate: there is no synthetic fallback, because
a check-in that quietly invented vitals would be worse than no check-in at all.

---

## Configuration

Everything is env-driven and read in the main process only.

| Variable | Default | Purpose |
|---|---|---|
| `SMARTSPECTRA_API_KEY` | — | SmartSpectra SDK key. Free from the [Presage portal](https://physiology.presagetech.com/auth/register). Read in `app/main` and never exposed to the renderer. |
| `KINVUE_CAPTURE_SECONDS` | `30` | Seconds of capture. Clamped to `SHORTEST_USEFUL_SECONDS`–`LONGEST_REASONABLE_SECONDS`; a value outside that, or one that cannot be read, is replaced and the replacement is printed at startup. The countdown and the sentence under the button both follow it. Raising this is how #63 gets the timings it needs — HRV did not arrive at 43s of capture and did at 58s. |
| `KINVUE_LOG_CAPTURE` | unset | Any non-empty value prints how long the camera took to close after each capture — `[capture] camera release: released in 340ms`. That figure is what `DEVICE_RELEASE_TIMEOUT_MS` is guessing at, and #63 is where it gets settled. A release that failed or outran the wait prints whether or not this is set. |

`app/main/env.ts` loads `.env` into `process.env` at startup, **in development only** — a
packaged app is launched from wherever its shortcut points, and reading whatever `.env`
happens to sit there is not a route into the process that owns the camera and the key.
Packaged installs therefore have no `.env` route at all yet; that is KV-19.

A variable already set in the environment wins over the file. A missing `.env` is normal
— the app starts, and capture fails with `MissingApiKeyError` when it is asked for a
reading. A `.env` that cannot be read is reported at startup instead.

**Quote a key containing `#`** (`SMARTSPECTRA_API_KEY="ab#cd"`). Node's `.env` parser
treats an unquoted `#` as the start of a comment and drops the rest of the value
silently, which then looks like a key the SDK rejects.

**The key is deliberately unprefixed.** A `MAIN_VITE_` name would be replaced into
`out/main` at build time, which writes the key into a built file in plain text.

There is no environment variable for seeding the demo history. Seeding happens when
someone presses the button on the dashboard, which is the only way it should be possible
to invent check-ins that did not happen (KV-8).

Tuned constants live in code, not env, because changing one changes what the app
*claims* and should go through review:

| Constant | Where | Default |
|---|---|---|
| `ELEVATED_SEVERITY_THRESHOLD` | `core/scoring` | `0.6` — summed severity at or above this is `elevated` |
| `MIN_CAPTURE_CONFIDENCE` | `core/session/usable.ts` | `0.5` — below this the capture is not scored, and it does not feed the baseline either. Re-exported from `core/scoring`, which is where most callers still import it from |
| `MIN_CAPTURE_SECONDS` | `core/session/usable.ts` | `20` — below this a capture is not scored. The gate is on the *recorded* duration, which excludes camera-open time. **More** load-bearing since captures became adaptive: `SHORTEST_USEFUL_SECONDS` used to make it unreachable by construction, and an early stop is now the one path that can record a duration under it |
| `DEFAULT_CAPTURE_SECONDS` | `core/capture/length.ts` | `90 s` — the **ceiling**, not the duration. A capture ends when every scorable metric has reported; reaching this means one never did. In `core/` so the renderer's countdown, `captureVitals` and the scorer all reference one number. Settable via `KINVUE_CAPTURE_SECONDS` |
| `SETTLE_AFTER_COMPLETE_SECONDS` | `core/capture/length.ts` | `5 s` — how long a capture runs on after the last metric arrives, so the slowest one is not reported on its first and noisiest reading |
| `CAMERA_OPEN_ALLOWANCE_SECONDS` | `core/capture/length.ts` | `10 s` — how much the camera may eat before the first frame. `SHORTEST_USEFUL_SECONDS` is `MIN_CAPTURE_SECONDS` plus this, so no setting can record a duration the scorer rejects |
| `MIN_BASELINE_SESSIONS` | `core/baseline` | `3` — below this the verdict is withheld |
| `BASELINE_WINDOW_SESSIONS` | `core/baseline` | `14` — trailing sessions in the baseline |
| `HRV_DROP_FIRES_AT` | `core/scoring/rules.ts` | `0.25` — fractional drop from baseline HRV |
| `DEMO_DAY_CEILING` | `core/seed/persona.ts` | `0.5` — a seeded demo day whose rules reach this is drawn again (KV-101) |
| `PENDING_CAPTURE_TTL_MS` | `core/session/checkin.ts` | `15 min` — past this, a reading cannot be submitted with answers given now |
| `GUIDANCE_PERSIST_MS` | `core/capture/guidance.ts` | `400 ms` — how long advice must hold before the person is shown it |
| `SETTLING_PERSIST_MS` | `core/capture/guidance.ts` | `2.5 s` — the same, for exposure advice a settling camera produces on its own (KV-1) |
| `GUIDANCE_REPEAT_MS` | `core/capture/guidance.ts` | `4 s` — a line already on screen is not re-sent more often than this |
| `FRAME_INTERVAL_MS` | `app/main/frames.ts` | `100 ms` — how often a self-view frame is sent, against the camera's ~30/s |
| `FRAME_WIDTH` | `app/main/frames.ts` | `320 px` — frames are sampled down to this during conversion, not after |
| `DEVICE_RELEASE_TIMEOUT_MS` | `app/main/release.ts` | `2 s` — how long a capture waits for the camera to actually close before dropping its lock. Measured releases on one machine ran 416–593 ms; the bound is unmeasured elsewhere and #63 owns it. Set `KINVUE_LOG_CAPTURE` to see the real figure. |

---

## Data Model

One record per check-in, appended to a JSON file. Sessions are never edited in place.

| Type | Notes |
|---|---|
| `Vitals` | `pulseRateBpm`, `breathingRateBrpm`, `hrvRmssdMs`, `hrvSdnnMs`, plus `confidence`, `stable` and `durationSec`. Any metric may be `null`. `confidence` describes the readings actually reported: per metric, the ones the SDK called settled, falling back to all of that metric’s readings when it settled on none. It is `null` when nothing rated the readings at all, and a null withholds the verdict rather than scoring it (KV-12). Once either rate in the capture is rated, each reports its newest reading that carried a confidence of its own, or `null` — an unrated reading cannot ride on another's number (KV-79). HRV neither vouches nor is vouched for: its own rating decides nothing and counts in no average, until HRV ratings have been seen on hardware. |
| `CheckInAnswers` | `mood`, `sleep`, `eatenToday`, `painReported` (+ optional `painNote`). All four are required: there is no way to say "not asked", so the flow collects all of them or stores nothing. |
| `FiredRule` | `id`, `title`, `explanation`, `severity`. One per rule that fired. |
| `Assessment` | `flag`, `firedRules`, `summary`, `baselineSessions`, plus the optional `baselineSeededSessions` and `uncomparedMetrics`. Written by the scorer. `uncomparedMetrics` lists the metrics measured at the check-in with too few readings of their own to have a usual, each with how many readings it had and how many were needed, and, when it had any, what they averaged; a would-be `normal` with any entry is withheld (KV-87). It is written only when the check-in was compared against a baseline at all, so it is **absent for two different reasons**: on an unusable capture or a baseline still learning, where nothing was compared and absence is correct, and on a verdict scored before KV-87, where absence means unknown. Read it as unknown only on a `normal` or `elevated` verdict. |
| `SessionRecord` | The above plus `id`, `personId`, `capturedAt` (UTC), `timeZone`, and `seeded` for demo history. |

`timeZone` is the IANA zone of the device at capture time, e.g. `Europe/London` — not a
UTC offset, which changes with daylight saving and cannot be applied to another date. It
is what makes "was this today?" answerable for the person who gave the check-in rather
than for whoever is reading it, and it cannot be recovered afterwards, so it is recorded
with the capture. `localDateOf` in `core/session/time.ts` turns it into a local day, and
answers `null` for a record written before this existed rather than guessing. The writing
end follows the same rule: `app/main/device.ts` records no zone at all when the device
cannot establish one, rather than the `UTC` that `Intl` falls back to.

---

## Privacy

This is part of the product, not a disclaimer. The population is elderly and the data is
physiological, so the design commits to the following and the code is arranged to make
them checkable:

- **No raw video is stored or transmitted.** Frames go from the camera into the SDK and
  are reduced to a handful of numbers. Nothing writes footage to disk. While a capture is
  running they also cross the preload bridge as small JPEGs so the person can see their
  own framing — held only long enough to draw, never saved, and never sent anywhere else.
- **No backend of ours, and no check-in leaves this machine.** Sessions are written and
  read locally; nothing here uploads them. The renderer's CSP is `default-src 'self'`, so
  the UI cannot load or call out to a remote origin even by accident.
- **The SDK itself contacts Presage during a capture, and a capture cannot run without
  it.** Measured, not assumed, with the SDK's own telemetry switched off. What goes out is
  a licence meter — session times and, per metric, how many readings were taken, not
  the readings or the video — established from the runtime's own schema and matched by
  the traffic volume, not by decrypting it (KV-65). This app is not offline and does not
  claim to be. Details and the remaining gap are under Architecture & Flow.
- **The API key stays in the main process.** The preload surface exposes named calls only
  — no generic `invoke(channel, ...)` — so a compromised renderer cannot read it.
- **Session data is local**, under Electron's `userData`, and `.gitignore` covers
  `sessions/` and video files so a check-in cannot be committed by accident.
- **Opt-in by design.** Capture runs only when someone presses the button. There is no
  background monitoring and no always-on camera.

These describe the app **as it is today**. Remote access — a caregiver seeing check-ins
from their own device — is planned, and it will change some of them. When it does, it will
be through documented decisions (see *Planning for remote access* in `ARCHITECTURE.md`),
consent will be required before anything leaves the device, and this section will be
rewritten in the same change that makes it untrue — not after.

---

## Conventions & Workflow

Branches + PRs only, never commit to `main` (the initial scaffold commit aside). The
repository settings do not enforce this or squash-only merging yet (KV-54).

- **Tickets** are GitHub issues, and a ticket's `KV-##` number *is* its issue number —
  KV-25 is #25. Issues and pull requests share GitHub's number sequence, so a number taken
  by a PR simply has no ticket.
- **Phases** are GitHub milestones. Labels carry the area (`vitals`, `scoring`, `ui`,
  `docs`, `ci`, `chore`, and `bug` for a `fix/` branch) and the kind of work (`remote`,
  `decision`, `privacy`, `security`). `backlog` marks a ticket whose phase has not
  started; `dormant` marks one shut on purpose — read it before reopening.
- **New tickets** take the shape of the issue forms: *Ticket* for work, *Decision* for a
  judgement call, which closes when `ARCHITECTURE.md` records the outcome rather than when
  code merges. The forms are the default, not a gate — blank issues stay enabled, and a
  ticket filed with `gh` or the API skips the forms whatever that setting says, so it
  follows the same sections by hand. A title filed as `KV-##: …` has its number filled in
  on open (`.github/workflows/issue-number.yml`).
- **Branch naming**: `category/KV-##-short-description`. Categories in use: `vitals`,
  `scoring`, `ui`, `docs`, `ci`, `chore`, `fix`, `security`, `remote`.
- **PR title**: `type(scope): KV-## description`.
- **PR body** carries a bare `Closes #<issue-number>`. `KV-##` alone is plain text to
  GitHub and closes nothing.
- **PRs** use the template (`.github/pull_request_template.md`). One ticket ≈ one PR.
- **CI** (`.github/workflows/ci.yml`) runs on every PR: lint, typecheck, test, build.
- **Dependabot** (`.github/dependabot.yml`) opens dependency PRs — weekly for npm, with
  minor and patch bumps grouped into one. They are the one exception to the ticket,
  branch-naming and PR-title rules: no KV number and no `Closes` line. Major versions,
  Electron and `@smartspectra/*` each arrive in their own PR.
- **A green Dependabot PR has not been run.** CI never launches Electron, and Dependabot
  PRs skip the template's *Ran the app* box. **An Electron bump is always launched before
  merging** (KV-145). How much more it needs depends on whether the Node and Chromium it
  vendors moved — not on whether Electron changed, which a patch always does. Compare
  `node_version` and `chromium_version` in Electron's `DEPS` at the old and new tag
  (`https://github.com/electron/electron/blob/v<version>/DEPS`):
  - **Both unchanged**: launch the PR **with no API key**, against an empty scratch store.
    `--user-data-dir` moves only the store: the key comes from `.env`, which is loaded
    from the working directory, so a launch from your own checkout finds it and *Take a
    reading* starts a real capture. Run from a separate worktree instead — `.env` is
    untracked, so a worktree has none:

    ```bash
    git fetch origin pull/<PR number>/head:check-<PR number>
    git worktree add ../kinvue-check check-<PR number>
    cd ../kinvue-check
    npm ci
    npx electron --version
    npm run dev -- -- --user-data-dir="<a scratch folder>"
    ```

    `npx electron --version` fetches the Electron binary, which this version downloads on
    first use rather than at install; without it the launch fails with "Electron
    uninstall". Afterwards, `git worktree remove ../kinvue-check`, `git branch -D
    check-<PR number>`, and delete the scratch folder.

    Check that the window appears on its own and already drawn; that the SDK's native
    runtime loaded (the main bundle loads it at startup, so the window appearing is the
    proof); that *Seed demo history* renders; and that *Take a reading* reaches **"This
    app is not set up yet"**. Put the two `DEPS` versions in the PR.
  - **Either changed, or a minor or major release**: all of that, **plus a real capture**
    with a key. A launch proves the SDK loads; only a capture calls into it and carries
    frames through to the preview the renderer draws.

  An SDK bump always needs a real capture, checked for new network behaviour against the
  privacy claims above, whatever the version. Why each level is enough, and what would
  make the lighter one stop being enough, is in `ARCHITECTURE.md`. KV-127 would automate
  the `DEPS` comparison.

  Electron and the SDK are pinned to exact versions in `package.json` so that npm will
  not pick up a new one on its own: a caret would let `npm update` move one inside
  lockfile churn, with none of those checks (KV-131). A test fails if either pin is
  relaxed. They are the only two pinned, because they are the only two whose risk CI
  cannot see — a native ABI and a network surface.

---

## Known Limitations / Gotchas

- **The SDK is validated in exactly one setting (KV-1).** One machine, one room. Real
  captures corrected several assumptions the reduction was first written on — see
  `ARCHITECTURE.md` and the `Vitals` row under *Data Model* for what it does now — and
  everything the scorer believes about what the SDK reports still rests on that setting.
  **HRV is the thinnest part of it.** HRV entries do arrive in the stream (30 in the first
  real capture), but an HRV reading reaching the record is rare: it arrived in one capture
  of eight counted in `core/capture/length.ts`, and in none of the five KV-87 was scored
  against. Whether an HRV reading ever carries a confidence of its own has not been seen
  (KV-79).
- **Signal quality depends on lighting and framing.** This is the SDK's constraint, not
  ours, and it is the most likely way a capture fails. Test in the actual room,
  early.
- **The demo persona's history is invented** (`core/seed/persona.ts`). A baseline needs
  weeks of check-ins and a new install has none, so a seeded fortnight is how the
  dashboard can be developed and shown with a baseline behind it. Each seeded day is scored
  when it is shown, against the days before it, as a real check-in is (KV-103) — so the
  fortnight always shows the current scorer's verdicts, and seeded cards leave the
  seeded-usual sentence to real cards compared against them. No seeded day may sum to
  `DEMO_DAY_CEILING` (0.5) or more; one that does is drawn again, so a demo seeded now
  cannot show an amber card by luck of the seed (KV-101). A demo seeded earlier keeps its
  old fortnight. Every seeded record carries
  `seeded: true` and the dashboard labels it. So does anything computed against it:
  `Assessment.baselineSeededSessions` counts the invented sessions behind a comparison, and
  `seededBaselineDisclosure` turns that count into the sentence the card shows wherever a
  verdict — or a fired rule quoting "their usual" — rests on them (KV-53). This is disclosed
  on purpose — in the UI and here. It does not help a real install, which still starts with
  no baseline (KV-17).
- **Severity weights are judgement, not evidence.** The numbers in `rules.ts` were chosen
  so that the combination the product exists to catch clears the threshold and a single
  soft signal does not. Answers can clear it on their own — six combinations do, all with
  pain — and one light answer rule, poor sleep, can tip a day the camera already has close
  to the line. Both are decisions, pinned in tests (KV-10, KV-91). On the camera side, no
  single rule flags a day by itself except an HRV drop of half or more; two camera rules
  together can. The arithmetic, and which camera-only days flag, is in `ARCHITECTURE.md`
  and pinned in `tests/scoring.test.ts`. None of this is calibrated against outcomes, and
  it should not be presented as if it were (KV-22).
- **A JSON file is the store.** Correct at one small record per person per day, and it
  avoids a native rebuild against Electron's ABI. `SessionStore` in
  `core/session/store.ts` is the seam to swap if that stops being true.
- **A store file that cannot be parsed stops the app, by design.** It is refused rather
  than treated as an empty history, because `append` is read-modify-write and "empty" would
  rename one record over the original. Until a new history is started, no history is shown
  and no check-in can be stored — a missing file and a zero-byte file are both still the
  ordinary first run. The dashboard offers **Start a new history**, which sets the file aside
  beside itself (`sessions.json.unreadable-<date>`) without ever deleting it or overwriting an
  earlier one, and refuses to move a file that has become readable again (KV-98). A history
  written by a newer version of Kinvue is never set aside — the newer version reads it. The
  reasoning is in `ARCHITECTURE.md`.
- **Downgrading strands the history.** The store file's `version` is read, so a build that
  writes version *n* refuses a file written by version *n+1*. Bumping it is a one-way door
  until #30 designs a migration.
- **`@smartspectra/node-sdk` depends on all four platform runtimes**, not just the host's
  — install pulls Windows, macOS and both Linux binaries regardless of platform.
- **Windows, macOS (Apple Silicon) and Linux only.** There is no `darwin-x64` runtime, so
  an Intel Mac cannot run the capture.

---

## Where to Look First

- **Understand the app** → this file, then `core/scoring/index.ts` (`scoreSession` is the
  spine) and `core/scoring/rules.ts`.
- **Change what gets flagged** → `core/scoring/rules.ts`. Read *Key Concepts* first.
- **Change what "usual" means** → `core/baseline/index.ts`.
- **Change the capture** → `app/main/vitals.ts` (+ the
  [SDK docs](https://smartspectra.presagetech.com/docs/nodejs.md)).
- **Change the dashboard** → `app/renderer/`.
- **Add an IPC call** → `app/main/index.ts` *and* `app/preload/index.ts` — both, by name.
