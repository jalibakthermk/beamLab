import { describe, expect, it } from 'vitest';
import { fmtCd, fmtDeg, fmtDegFixed, fmtLm, fmtLx, fmtM, fmtPct, fmtSig, fmtStatus } from '../core/format';

describe('number formatting (one place)', () => {
  it('cd, lx, degrees, percent, metres, lm', () => {
    expect([fmtCd(12345.6), fmtCd(56.24), fmtCd(0.01234), fmtCd(0), fmtCd(NaN)]).toEqual(['12,346', '56.2', '0.0123', '0', '—']);
    expect([fmtLx(1234.4), fmtLx(12.34), fmtLx(1.234), fmtLx(0.1234)]).toEqual(['1,234', '12.3', '1.23', '0.123']);
    expect([fmtDeg(-0.5729), fmtDeg(2), fmtDeg(-0.0001), fmtDegFixed(-0.0001), fmtDegFixed(1.5)]).toEqual(['-0.57°', '2°', '0°', '0.000°', '1.500°']);
    expect([fmtPct(12.345, 1), fmtPct(2, 2, true), fmtPct(-0.04, 1), fmtPct(null)]).toEqual(['12.3%', '+2.00%', '-0.0%'.replace('-', ''), '—']);
    expect([fmtM(3.5, 2, true), fmtM(-0.001), fmtLm(1234.5), fmtLm(12.3456)]).toEqual(['3.50 m', '0.00', '1,235 lm', '12.35 lm']);
    expect([fmtSig(1.23456e-7, 3), fmtSig(123456, 3), fmtSig(-0.0004, 2)]).toEqual(['0.000000123', '123000', '-0.0004']);
  });
  it('status is text with an icon, never colour alone', () => {
    expect([fmtStatus('pass'), fmtStatus('fail'), fmtStatus('not-evaluated'), fmtStatus('incomplete')]).toEqual(['✓ pass', '✗ fail', '– not evaluated', '◐ incomplete']);
  });
});
