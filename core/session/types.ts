/**
 * The shapes that flow through the whole app: one capture, one set of answers,
 * one scored record. Nothing here imports Electron or React — core/ is plain
 * TypeScript so the rules can be unit-tested without a window or a camera.
 */

/**
 * Vitals from a single SmartSpectra measurement, flattened from the SDK's
 * time-series into the summary values a check-in actually stores.
 *
 * The SDK returns each metric as a series of samples with per-sample
 * confidence (`cardio.pulseRate[]`, `cardio.hrv[]`, `breathing.rate[]`); the
 * capture layer reduces those to the values below. A metric the SDK never
 * reported with usable confidence stays `null` rather than defaulting to a
 * number — a missing reading and a reading of zero must not look alike to the
 * rules.
 */
export interface Vitals {
  /** Beats per minute. */
  pulseRateBpm: number | null
  /** Breaths per minute. */
  breathingRateBrpm: number | null
  /** HRV, root mean square of successive differences, in milliseconds. */
  hrvRmssdMs: number | null
  /** HRV, standard deviation of NN intervals, in milliseconds. */
  hrvSdnnMs: number | null
  /**
   * The SDK's own confidence in the readings being reported, 0..1 (KV-12).
   *
   * Averaged over the readings it called settled — the same ones the values
   * above come from — falling back to every reading when it settled on none.
   * Zero when nothing reported a confidence at all, which is not the same as
   * a measured zero and is still conflated with one; see KV-12.
   */
  confidence: number
  /**
   * Whether the SDK marked the reading being reported as settled. The flag is
   * declared on the rate readings and on HRV alike, but in the KV-1 capture
   * only `cardio.pulseRate[]` and `breathing.rate[]` ever set it — HRV never
   * reported `stable: true`, which is an observation about that capture and
   * not a fact about the schema.
   */
  stable: boolean
  /** Seconds of usable capture. Short captures are not scored. */
  durationSec: number
}

/**
 * What the renderer gets back from a capture. The vitals are for display only:
 * `submit` takes the `captureId`, never the vitals, so the numbers that are
 * scored and stored can only be the ones the main process measured.
 */
export interface CaptureResult {
  captureId: string
  vitals: Vitals
}

export type MoodAnswer = 'good' | 'ok' | 'low'
export type SleepAnswer = 'well' | 'ok' | 'poorly'

/** The four questions asked after the capture. Deliberately short. */
export interface CheckInAnswers {
  mood: MoodAnswer
  sleep: SleepAnswer
  eatenToday: boolean
  painReported: boolean
  /** Free text, only collected when painReported is true. */
  painNote?: string
}

/** One rule that fired, in the words the caregiver reads. */
export interface FiredRule {
  /** Stable identifier, e.g. `hrv-drop`. Used in tests and in the trend view. */
  id: string
  /** Short label, e.g. "HRV below usual". */
  title: string
  /** One plain-language sentence naming the actual numbers. */
  explanation: string
  /**
   * How much this contributes to the flag, 0..1. Severities sum; see
   * core/scoring for the threshold. Not a probability and not a risk score —
   * it exists only to order and combine rules.
   */
  severity: number
}

export type Flag =
  /** Nothing stood out against this person's own baseline. */
  | 'normal'
  /** At least one rule fired hard enough to be worth a caregiver's attention. */
  | 'elevated'
  /** Not enough usable signal, or not enough history, to say either way. */
  | 'insufficient-signal'

export interface Assessment {
  flag: Flag
  /** Every rule that fired, highest severity first. Never summarised away. */
  firedRules: FiredRule[]
  /** One sentence for the top of the card. */
  summary: string
  /** How many past sessions the baseline was computed from. */
  baselineSessions: number
  /**
   * How many of those were seeded demo history rather than measured (KV-53).
   * Above zero, this verdict rests on invented numbers, and both the summary
   * and the card say so. Zero on a real install, which never seeds unless
   * someone asks it to.
   *
   * Optional because a session scored before KV-53 has no such field, and a
   * record that predates a field is not a record with a zero in it. Read it as
   * "unknown", not as "none": absent means nobody asked the question.
   */
  baselineSeededSessions?: number
}

export interface SessionRecord {
  id: string
  /** Which cared-for person this check-in belongs to. */
  personId: string
  /** ISO-8601 timestamp of the capture, in UTC. */
  capturedAt: string
  /**
   * IANA time zone of the device that recorded the capture, e.g.
   * `Europe/London` (KV-28). An IANA name, never a UTC offset: offsets change
   * with daylight saving and cannot be applied to another date.
   *
   * `capturedAt` alone cannot say which day a check-in belongs to for the
   * person who gave it — 23:30 in one zone is tomorrow in another — and a
   * caregiver reading from elsewhere needs *their* today, not the reader's.
   * That meaning cannot be recovered afterwards, so it is recorded at capture.
   *
   * Optional because a record written before this existed has no zone, and a
   * missing zone must not be guessed into a wrong one. Absent means unknown;
   * `localDateOf` answers null rather than inventing a day.
   */
  timeZone?: string
  vitals: Vitals
  answers: CheckInAnswers
  /** Written by the scorer; absent until the session has been scored. */
  assessment?: Assessment
  /**
   * True for the pre-seeded demo history (KV-8). The dashboard labels these
   * rather than hiding them — a demo persona's history is not real data and
   * the UI should not imply that it is.
   */
  seeded?: boolean
}
