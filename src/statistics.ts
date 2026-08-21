/**
 * The mean of a set of measurements.
 *
 * A measurement that is not a finite number is not a measurement: it is a
 * scorer that divided by zero or an adapter that answered with nothing usable.
 * Averaging it in would spread one broken probe across the whole aggregate,
 * and carrying it through would make the aggregate itself unusable — a
 * non-finite `scoreMean` fails every numeric comparison in the ranking
 * comparator, so the candidate carrying it falls through to the identifier
 * tie-break and places by name rather than by what it scored. Such values are
 * left out, and the mean reports what was actually measured.
 *
 * An empty set answers `0`. That is a reported score, not an absence, and it
 * is the behavior every caller in this package already depends on.
 */
export function mean(values: readonly number[]): number {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return 0
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}
