/** Linear interpolation over sorted [beat, value] breakpoints; holds the ends. */
export function valueAt(points: [number, number][], beat: number): number {
  const n = points.length;
  if (n === 0) return 0;
  if (beat <= points[0][0]) return points[0][1];
  if (beat >= points[n - 1][0]) return points[n - 1][1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= beat) lo = mid; else hi = mid;
  }
  const [b0, v0] = points[lo], [b1, v1] = points[hi];
  return b1 === b0 ? v1 : v0 + ((beat - b0) / (b1 - b0)) * (v1 - v0);
}
