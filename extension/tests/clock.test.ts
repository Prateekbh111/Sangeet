import { describe, it, expect } from 'vitest';
import { Clock } from '../src/sync/clock';

describe('Clock', () => {
  it('returns NaN rtt and 0 offset when empty', () => {
    const c = new Clock();
    expect(Number.isNaN(c.rtt())).toBe(true);
    expect(c.offset()).toBe(0);
    expect(c.samples()).toBe(0);
  });

  it('perfect samples yield offset 0 and rtt 0', () => {
    const c = new Clock();
    for (let i = 0; i < 5; i++) {
      const t1 = 1000 + i * 100;
      const t2 = t1;
      const t3 = t1;
      const t4 = t1;
      c.addSample(t1, t2, t3, t4);
    }
    expect(c.offset()).toBe(0);
    expect(c.rtt()).toBe(0);
    expect(c.samples()).toBe(5);
  });

  it('peer +100ms skew gives offset ~100', () => {
    const c = new Clock();
    const skew = 100;
    for (let i = 0; i < 5; i++) {
      const t1 = 1000 + i * 100;
      const oneWay = 10;
      const t2 = t1 + oneWay + skew;
      const t3 = t2 + 1;
      const t4 = t3 - skew + oneWay;
      c.addSample(t1, t2, t3, t4);
    }
    expect(Math.abs(c.offset() - 100)).toBeLessThan(0.001);
  });

  it('discards outlier whose rtt > 3 * median rtt', () => {
    const c = new Clock();
    // 9 normal samples: rtt ~20ms, offset 50
    for (let i = 0; i < 9; i++) {
      const t1 = 1000 + i * 100;
      const t2 = t1 + 10 + 50; // one-way 10, skew 50
      const t3 = t2 + 1;
      const t4 = t3 - 50 + 10;
      c.addSample(t1, t2, t3, t4);
    }
    // outlier sample with rtt ~500 and a wildly different offset
    const t1 = 2000;
    const t2 = t1 + 250 + 9999; // huge fake offset embedded
    const t3 = t2 + 1;
    const t4 = t3 - 9999 + 250;
    c.addSample(t1, t2, t3, t4);

    const med = c.offset();
    // Should still be ~50 because outlier is excluded
    expect(Math.abs(med - 50)).toBeLessThan(0.001);
  });
});
