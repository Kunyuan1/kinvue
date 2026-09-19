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
> deadline. The repository is scaffolded and the scoring engine and its tests are real,
> but the app cannot yet record a check-in end to end (KV-2) — nothing in the UI starts a
> capture. The SmartSpectra capture (`app/main/vitals.ts`) **has now returned real pulse,
> breathing and HRV from a webcam** (KV-1), on one machine in one room, which corrected
> several assumptions this code was built on. The capture-length constants (KV-63) and
> what the SDK sends to Presage (KV-65) are still open.

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
  renderer/
    index.html           CSP: default-src 'self' — the UI loads nothing off the
                         network. img-src also allows blob:, for the self-view.
    App.tsx              caregiver dashboard shell
    components/
      CaptureScreen.tsx  the 30s in front of the camera — the one screen the
                         cared-for person reads, not the caregiver
      SessionCard.tsx    one check-in + the rules that fired
    styles.css           Tailwind v4 theme tokens

core/                    Plain TypeScript. No Electron, no React — unit-testable.
  session/
    types.ts             Vitals, CheckInAnswers, FiredRule, Assessment, SessionRecord
    store.ts             JSON session store (MAIN PROCESS ONLY — imports node:fs)
    validate.ts          runtime checks on everything the renderer sends to main
    checkin.ts           holds a capture until its answers arrive, then scores and stores it
    time.ts              which local day a check-in belongs to, where it was taken
  baseline/index.ts      per-person trailing baseline + MIN_BASELINE_SESSIONS
  scoring/
    rules.ts             every rule, each independently testable
    index.ts             the engine: severity sum → flag + explanation
  capture/guidance.ts    which of the camera's hints are worth showing the person
  seed/persona.ts        the demo persona's invented history (KV-8, disclosed)

tests/                   Vitest. Covers baseline, scoring, validation, check-in, time,
                         device, guidance, frames, vitals and env.
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
  is more trustworthy than a bare green tick.
- **Rules, not a trained model — on purpose.** There is no labelled dataset of "days
  before an older adult got ill", and a model trained on synthetic data would be a
  confident guess dressed as evidence. See `ARCHITECTURE.md`.
- **`insufficient-signal` is a real answer.** A poor camera reading, a capture cut short,
  or a baseline that is still building all produce a withheld verdict rather than a
  cheerful green. Scoring the answers alone and calling it `normal` would misrepresent
  what was actually measured.
- **Missing is not zero.** A metric the SDK never reported with usable confidence stays
  `null` through the whole pipeline. A reading of zero and no reading at all must never
  look alike to a rule.
- **Severity is not risk.** The 0..1 severity on each rule exists only to order and
  combine rules against `ELEVATED_SEVERITY_THRESHOLD`. It is not a probability, it is not
  calibrated against outcomes, and it must not be shown to a caregiver as a score.

---

## Local Development

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
npm test             # vitest, node environment, ~1s
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
| `MIN_CAPTURE_CONFIDENCE` | `core/scoring` | `0.5` — below this the capture is not scored |
| `MIN_CAPTURE_SECONDS` | `core/scoring` | `20` — the UI asks for ~30 |
| `MIN_BASELINE_SESSIONS` | `core/baseline` | `3` — below this the verdict is withheld |
| `BASELINE_WINDOW_SESSIONS` | `core/baseline` | `14` — trailing sessions in the baseline |
| `HRV_DROP_FIRES_AT` | `core/scoring/rules.ts` | `0.25` — fractional drop from baseline HRV |
| `PENDING_CAPTURE_TTL_MS` | `core/session/checkin.ts` | `15 min` — past this, a reading cannot be submitted with answers given now |
| `GUIDANCE_PERSIST_MS` | `core/capture/guidance.ts` | `400 ms` — how long advice must hold before the person is shown it |
| `SETTLING_PERSIST_MS` | `core/capture/guidance.ts` | `2.5 s` — the same, for exposure advice a settling camera produces on its own (KV-1) |
| `GUIDANCE_REPEAT_MS` | `core/capture/guidance.ts` | `4 s` — a line already on screen is not re-sent more often than this |
| `FRAME_INTERVAL_MS` | `app/main/frames.ts` | `100 ms` — how often a self-view frame is sent, against the camera's ~30/s |
| `FRAME_WIDTH` | `app/main/frames.ts` | `320 px` — frames are sampled down to this during conversion, not after |

---

## Data Model

One record per check-in, appended to a JSON file. Sessions are never edited in place.

| Type | Notes |
|---|---|
| `Vitals` | `pulseRateBpm`, `breathingRateBrpm`, `hrvRmssdMs`, `hrvSdnnMs`, plus `confidence`, `stable` and `durationSec`. Any metric may be `null`. `confidence` describes the readings actually reported — the ones the SDK called settled (KV-12). |
| `CheckInAnswers` | `mood`, `sleep`, `eatenToday`, `painReported` (+ optional `painNote`). |
| `FiredRule` | `id`, `title`, `explanation`, `severity`. One per rule that fired. |
| `Assessment` | `flag`, `firedRules`, `summary`, `baselineSessions`, `baselineSeededSessions`. Written by the scorer. |
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
- **The SDK itself contacts Presage during a capture.** Measured, not assumed: every
  capture opens an outbound TLS connection as the session starts, with the SDK's own
  telemetry switched off. What that request contains has not been established — most
  likely a key check — and until it has, this app cannot claim to be offline (KV-65).
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
  PRs skip the template's *Ran the app* box. An Electron bump needs `npm run dev` before
  merging, and an SDK bump needs a real capture too, checked for new network behaviour
  against the privacy claims above.

---

## Known Limitations / Gotchas

- **The SDK is not yet validated on hardware (KV-1).** `app/main/vitals.ts` is written
  against the documented Node API and has never returned a real reading in this repo. The
  reduction it does — last settled sample for pulse and breathing, last `stable` sample
  for HRV, confidence averaged across the capture — is a reasonable reading of the docs
  and needs confirming against a live session.
- **Signal quality depends on lighting and framing.** This is the SDK's constraint, not
  ours, and it is the most likely way a capture fails. Test in the actual room,
  early.
- **The demo persona's history is invented** (`core/seed/persona.ts`). A baseline needs
  weeks of check-ins and a new install has none, so a seeded fortnight is how the
  dashboard can be developed and shown with a baseline behind it. Every seeded record
  carries `seeded: true` and the dashboard labels it. So does anything computed against it:
  `Assessment.baselineSeededSessions` counts the invented sessions behind a comparison, and
  `seededBaselineDisclosure` turns that count into the sentence the card shows wherever a
  verdict — or a fired rule quoting "their usual" — rests on them (KV-53). This is disclosed
  on purpose — in the UI and here. It does not help a real install, which still starts with
  no baseline (KV-17).
- **Severity weights are judgement, not evidence.** The numbers in `rules.ts` were chosen
  so that the combination the product exists to catch clears the threshold and a single
  soft signal does not. They are not calibrated against outcomes and should not be
  presented as if they were.
- **A JSON file is the store.** Correct at one small record per person per day, and it
  avoids a native rebuild against Electron's ABI. `SessionStore` in
  `core/session/store.ts` is the seam to swap if that stops being true.
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
