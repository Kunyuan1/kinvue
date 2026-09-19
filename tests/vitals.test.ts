import { describe, expect, it } from 'vitest'
// The /messages entry point deliberately avoids requiring ../ffi, so importing
// it does not load the native runtime — unlike the package root.
import { decodeMetrics, presage } from '@smartspectra/node-sdk/messages'
import { createVitalsAccumulator, type MetricsLike } from '../app/main/metrics'

/**
 * `app/main/metrics.ts` is the reduction, split out of `vitals.ts` so it can be
 * tested here in the same no-camera, no-Electron suite as core/.
 *
 * The shapes mirror what a real capture emitted (KV-1): a metrics message
 * carries whichever metrics were ready at that instant, and `stable` and
 * `confidence` sit on the readings. The values are invented — a real person's
 * readings are not test data.
 */

const breathingMsg = (value: number, confidence = 70, stable = true): MetricsLike => ({
  breathing: { rate: [{ value, confidence, stable }] },
})

const pulseMsg = (value: number, confidence = 90, stable = true): MetricsLike => ({
  cardio: { pulseRate: [{ value, confidence, stable }] },
})

const hrvMsg = (rmssd: number, sdnn: number): MetricsLike => ({
  cardio: { hrv: [{ rmssd, sdnn, meanNn: 600, baevsky: 2.5 }] },
})

/** A trace-only message, which is most of what the stream actually carries. */
const traceMsg = (): MetricsLike => ({
  breathing: { upperTrace: [{ value: -0.47, stable: true }] },
})

describe('createVitalsAccumulator', () => {
  it('keeps each metric from the message that carried it', () => {
    // The failure this exists to prevent: reading every metric off the final
    // message returns whatever that one happened to hold.
    const acc = createVitalsAccumulator()
    acc.add(pulseMsg(64))
    acc.add(breathingMsg(14))
    acc.add(hrvMsg(41, 52))
    acc.add(traceMsg())
    const result = acc.result(60)

    expect(result.pulseRateBpm).toBe(64)
    expect(result.breathingRateBrpm).toBe(14)
    expect(result.hrvRmssdMs).toBe(41)
    expect(result.hrvSdnnMs).toBe(52)
    expect(result.stable).toBe(true)
    expect(result.durationSec).toBe(60)
  })

  it('keeps the latest reading of each metric, not the first', () => {
    const acc = createVitalsAccumulator()
    acc.add(pulseMsg(61))
    acc.add(pulseMsg(67))
    acc.add(hrvMsg(44, 55))
    acc.add(hrvMsg(39, 50))
    const result = acc.result(45)

    expect(result.pulseRateBpm).toBe(67)
    expect(result.hrvRmssdMs).toBe(39)
  })

  it('reports the last reading the SDK called stable, not a late outlier', () => {
    // Someone shifts in their chair at the end of a capture. No rule downstream
    // reads `stable`, so an unstable final reading would otherwise be quoted to
    // the caregiver as "pulse above their usual".
    const acc = createVitalsAccumulator()
    acc.add(pulseMsg(68, 90, true))
    acc.add(pulseMsg(104, 55, false))

    expect(acc.result(30).pulseRateBpm).toBe(68)
  })

  it('reports an unstable reading when the SDK never called one stable', () => {
    const acc = createVitalsAccumulator()
    acc.add(pulseMsg(104, 55, false))
    const result = acc.result(30)

    expect(result.pulseRateBpm).toBe(104)
    expect(result.stable).toBe(false)
  })

  it('leaves a metric the SDK never reported as null, not zero', () => {
    const acc = createVitalsAccumulator()
    acc.add(breathingMsg(13))
    const result = acc.result(30)

    expect(result.breathingRateBrpm).toBe(13)
    expect(result.pulseRateBpm).toBeNull()
    expect(result.hrvRmssdMs).toBeNull()
    expect(result.hrvSdnnMs).toBeNull()
  })

  it('reports a genuine zero reading as zero, not as missing', () => {
    const acc = createVitalsAccumulator()
    acc.add(pulseMsg(0, 80))

    expect(acc.result(30).pulseRateBpm).toBe(0)
  })

  it('keeps a breathing-only capture usable, with its own confidence', () => {
    // Averaging pulse alone would score 0 here and the capture would be thrown
    // away as unreadable despite carrying a clean breathing rate (KV-12).
    const acc = createVitalsAccumulator()
    acc.add(breathingMsg(14, 80))
    const result = acc.result(30)

    expect(result.breathingRateBrpm).toBe(14)
    expect(result.confidence).toBeCloseTo(0.8, 5)
  })

  it('averages the confidence of the readings it is reporting', () => {
    // The values reported come from the newest settled reading, so the
    // confidence beside them comes from the same place. Readings the SDK
    // distrusted are scattered through a capture, not clustered at its start:
    // across recorded runs, averaging them in pulled 0.64 down to 0.45 and
    // discarded captures carrying a settled pulse and breathing rate.
    const acc = createVitalsAccumulator()
    acc.add(pulseMsg(64, 90, true))
    acc.add(pulseMsg(101, 20, false))
    acc.add(pulseMsg(65, 90, true))

    expect(acc.result(30).confidence).toBeCloseTo(0.9, 5)
  })

  it('falls back to every reading when the SDK settled on none of them', () => {
    // Then that is what the numbers rest on, and the confidence should say so
    // rather than pretend there is nothing to report.
    const acc = createVitalsAccumulator()
    acc.add(pulseMsg(101, 40, false))
    acc.add(pulseMsg(99, 20, false))

    expect(acc.result(30).confidence).toBeCloseTo(0.3, 5)
  })

  it('reports nothing measured as all null with zero confidence', () => {
    const result = createVitalsAccumulator().result(30)

    expect(result.pulseRateBpm).toBeNull()
    expect(result.breathingRateBrpm).toBeNull()
    expect(result.confidence).toBe(0)
    expect(result.stable).toBe(false)
  })

  it('averages every reading in a message, not just the last one', () => {
    // A message can batch several readings; taking only the last overstates a
    // capture that was mostly unconfident.
    const acc = createVitalsAccumulator()
    acc.add({
      cardio: {
        pulseRate: [
          { value: 62, confidence: 40, timestamp: '1' },
          { value: 63, confidence: 45, timestamp: '2' },
          { value: 64, confidence: 95, timestamp: '3' },
        ],
      },
    })

    expect(acc.result(30).confidence).toBeCloseTo(0.6, 5)
  })

  it('does not count a reading twice when messages repeat it', () => {
    const acc = createVitalsAccumulator()
    const reading = { value: 64, confidence: 90, timestamp: '7' }
    acc.add({ cardio: { pulseRate: [reading] } })
    acc.add({ cardio: { pulseRate: [reading, { value: 65, confidence: 30, timestamp: '8' }] } })

    expect(acc.result(30).confidence).toBeCloseTo(0.6, 5)
  })

  it('ignores trace samples, which are not rates', () => {
    const acc = createVitalsAccumulator()
    acc.add(traceMsg())

    expect(acc.result(30).breathingRateBrpm).toBeNull()
  })
})

describe('createVitalsAccumulator, against real decoded messages', () => {
  /**
   * The fixtures above are plain objects. A decoded message is a protobufjs
   * instance whose proto3 defaults live on the prototype, so an unset `value`
   * reads as `0` rather than `undefined` — which is why the reduction decides
   * presence by own-property. Only a real message can pin that.
   */
  const Metrics = presage.smartspectra.Metrics

  const decoded = (payload: Parameters<typeof Metrics.create>[0]): MetricsLike =>
    decodeMetrics(Buffer.from(Metrics.encode(Metrics.create(payload)).finish()))

  it('treats a reading the SDK left unset as missing, not as zero', () => {
    // The reading exists but carries no value: on the wire, nothing was sent.
    const acc = createVitalsAccumulator()
    acc.add(decoded({ cardio: { pulseRate: [{ stable: true }] } }))
    const result = acc.result(30)

    expect(result.pulseRateBpm).toBeNull()
    expect(result.confidence).toBe(0)
  })

  it('does not average an unset confidence in as zero', () => {
    const acc = createVitalsAccumulator()
    acc.add(decoded({ cardio: { pulseRate: [{ value: 64, confidence: 85, timestamp: 1 }] } }))
    acc.add(decoded({ cardio: { pulseRate: [{ value: 65, timestamp: 2 }] } }))

    // Two readings, one confidence reported: 0.85, not (0.85 + 0) / 2.
    expect(acc.result(30).confidence).toBeCloseTo(0.85, 5)
  })

  it('reads the values the SDK did set', () => {
    const acc = createVitalsAccumulator()
    acc.add(decoded({ cardio: { hrv: [{ rmssd: 41, sdnn: 52 }] } }))
    const result = acc.result(30)

    expect(result.hrvRmssdMs).toBe(41)
    expect(result.hrvSdnnMs).toBe(52)
  })
})
