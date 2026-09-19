import type { Vitals } from '@core/session/types'

/**
 * Reducing the SDK's sample stream to one `Vitals`.
 *
 * **Imports nothing from the SDK on purpose.** `@smartspectra/node-sdk` loads
 * its native runtime through koffi at import time, so a module that touches it
 * cannot be unit-tested on a machine without a runtime for that platform —
 * there is no darwin-x64 one at all. `vitals.ts` pins these shapes against the
 * SDK's own types at compile time so the decoupling cannot drift into a typo.
 *
 * **A decoded message is a protobufjs instance, not a plain object.** Proto3
 * defaults live on the prototype, so an unset `value` reads as `0` and an unset
 * `confidence` reads as `0` — never `undefined`. Presence is therefore decided
 * by own-property, never by the value itself. Missing is not zero, and here is
 * where a missing reading would otherwise become a measured zero.
 */

/** One reading of a rate metric: `cardio.pulseRate[]`, `breathing.rate[]`. */
export interface RateReading {
  value?: number | null
  /** The SDK's own confidence, as a percentage in [0, 100]. */
  confidence?: number | null
  /** Whether the SDK considered this reading settled. */
  stable?: boolean | null
  /** Microseconds since the epoch. Only used to avoid counting a reading twice. */
  timestamp?: unknown
}

/** One HRV entry. The schema carries `confidence` and `stable` here too. */
export interface HrvReading {
  rmssd?: number | null
  sdnn?: number | null
  meanNn?: number | null
  baevsky?: number | null
  confidence?: number | null
  stable?: boolean | null
  timestamp?: unknown
}

/** As much of a decoded metrics message as the reduction reads. */
export interface MetricsLike {
  cardio?: {
    pulseRate?: readonly RateReading[] | null
    hrv?: readonly HrvReading[] | null
  } | null
  breathing?: {
    rate?: readonly RateReading[] | null
    /** Waveform points, not a rate. Most of the stream is these; ignored here. */
    upperTrace?: readonly RateReading[] | null
  } | null
}

/**
 * The field's value, or undefined when the SDK did not set it.
 *
 * `reading.value ?? null` cannot do this job: the prototype default answers
 * first and a reading that reported nothing arrives as a confident zero.
 */
function set<T extends object, K extends keyof T>(reading: T, key: K): T[K] | undefined {
  return Object.hasOwn(reading, key as string) ? reading[key] : undefined
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

/**
 * Tracks one metric across the stream: the newest reading, and separately the
 * newest the SDK marked stable.
 */
class Tracked<T extends object> {
  latest: T | undefined
  latestStable: T | undefined
  /** Timestamps already counted, so a repeated reading is not averaged twice. */
  private readonly counted = new Set<string>()

  /** Confidences this message contributed, in [0, 1], split by the SDK's verdict. */
  observe(readings: readonly T[] | null | undefined): Confidences {
    const confidences: Confidences = { settled: [], all: [] }
    if (readings === null || readings === undefined) return confidences

    for (const reading of readings) {
      // Every reading in the message counts toward the average, not just the
      // last: a message batching 40%, 45% and 95% must not read as 95%.
      const stamp = set(reading, 'timestamp' as keyof T)
      const key = stamp === undefined ? undefined : String(stamp)
      if (key !== undefined && this.counted.has(key)) continue
      if (key !== undefined) this.counted.add(key)

      this.latest = reading
      if (set(reading, 'stable' as keyof T) === true) this.latestStable = reading

      const confidence = set(reading, 'confidence' as keyof T)
      if (typeof confidence === 'number') {
        confidences.all.push(confidence / 100)
        if (set(reading, 'stable' as keyof T) === true) confidences.settled.push(confidence / 100)
      }
    }
    return confidences
  }

  /**
   * The reading to report: the newest one the SDK called stable, falling back
   * to the newest of any kind. Someone shifting in their chair at the end of a
   * capture must not overwrite nine settled seconds with one outlier — and no
   * rule downstream consults `stable`, so this is where that verdict is used.
   */
  get chosen(): T | undefined {
    return this.latestStable ?? this.latest
  }
}

/** Confidences from one message: those the SDK called settled, and all of them. */
interface Confidences {
  settled: number[]
  all: number[]
}

export interface VitalsAccumulator {
  add(metrics: MetricsLike): void
  result(durationSec: number): Vitals
}

/**
 * Collects the sample stream into one `Vitals`.
 *
 * **A metrics message carries whichever metrics were ready at that instant,
 * not all of them.** Measured over a real 60s capture (KV-1): 1309 messages
 * carried breathing only, 118 cardio only, and 90 both. So each metric is kept
 * as it arrives rather than read off the final message — reading them all off
 * one message returns whatever that message happened to hold and silently
 * discards the rest, while `captureIsUsable` still calls the check-in usable.
 */
export function createVitalsAccumulator(): VitalsAccumulator {
  const pulse = new Tracked<RateReading>()
  const breathing = new Tracked<RateReading>()
  const hrv = new Tracked<HrvReading>()
  const settled: number[] = []
  const everything: number[] = []

  const collect = (from: Confidences): void => {
    settled.push(...from.settled)
    everything.push(...from.all)
  }

  return {
    add(metrics) {
      // Confidence spans every metric that reports one. Pulse alone would make
      // this a pulse-presence check wearing a confidence threshold's clothes:
      // a capture with a clean breathing rate and no pulse would average zero
      // and be discarded as unusable (KV-12).
      collect(pulse.observe(metrics.cardio?.pulseRate))
      collect(breathing.observe(metrics.breathing?.rate))
      collect(hrv.observe(metrics.cardio?.hrv))
    },

    result(durationSec) {
      const chosenPulse = pulse.chosen
      const chosenBreathing = breathing.chosen
      const chosenHrv = hrv.chosen

      return {
        pulseRateBpm: num(chosenPulse && set(chosenPulse, 'value')),
        breathingRateBrpm: num(chosenBreathing && set(chosenBreathing, 'value')),
        hrvRmssdMs: num(chosenHrv && set(chosenHrv, 'rmssd')),
        hrvSdnnMs: num(chosenHrv && set(chosenHrv, 'sdnn')),
        // Describes the readings actually being reported (KV-12).
        //
        // The values above come from the newest reading the SDK called stable,
        // so the confidence beside them comes from the same place. Averaging
        // every reading instead mixes in the ones the SDK distrusted, and those
        // are scattered through a capture rather than clustered at its start:
        // across recorded runs that pulled 0.64 down to 0.45, under
        // MIN_CAPTURE_CONFIDENCE, and threw away captures carrying a settled
        // pulse and breathing rate.
        //
        // Falls back to every reading when the SDK never called one settled —
        // then that is what the numbers rest on, and saying so is the point.
        // Still one number for the whole session; whether a metric whose own
        // confidence is poor should be nulled instead of gating the whole
        // capture is left open, because it changes when rules fire.
        confidence: averageOf(settled.length > 0 ? settled : everything),
        // True when the reading being reported is one the SDK itself called
        // settled. Reported per capture; nothing gates on it yet (KV-12).
        stable: reportedStable(chosenPulse, chosenBreathing),
        durationSec,
      }
    },
  }
}

/** Zero for an empty capture: nothing was measured, so nothing is claimed. */
const averageOf = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((s, v) => s + v, 0) / xs.length

/**
 * Pulse decides when it reported a flag, because every vitals rule leans on it
 * hardest; breathing answers only when pulse said nothing either way.
 */
function reportedStable(
  pulse: RateReading | undefined,
  breathing: RateReading | undefined,
): boolean {
  const fromPulse = pulse === undefined ? undefined : set(pulse, 'stable')
  if (typeof fromPulse === 'boolean') return fromPulse
  const fromBreathing = breathing === undefined ? undefined : set(breathing, 'stable')
  return fromBreathing === true
}
