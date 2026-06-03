// Clock sync using NTP-style 4-timestamp samples.
// clockOffset semantics: offset = peerClock - localClock, so local = peer - offset.

interface Sample {
  rtt: number;
  offset: number;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export class Clock {
  private window: Sample[] = [];
  private readonly maxSamples = 10;

  addSample(t1: number, t2: number, t3: number, t4: number): void {
    const rtt = (t4 - t1) - (t3 - t2);
    const offset = ((t2 - t1) + (t3 - t4)) / 2;
    this.window.push({ rtt, offset });
    if (this.window.length > this.maxSamples) {
      this.window.shift();
    }
  }

  rtt(): number {
    if (this.window.length === 0) return NaN;
    return median(this.window.map((s) => s.rtt));
  }

  offset(): number {
    if (this.window.length === 0) return 0;
    const medRtt = median(this.window.map((s) => s.rtt));
    const filtered = this.window.filter((s) => s.rtt <= 3 * medRtt);
    const pool = filtered.length > 0 ? filtered : this.window;
    return median(pool.map((s) => s.offset));
  }

  samples(): number {
    return this.window.length;
  }
}
