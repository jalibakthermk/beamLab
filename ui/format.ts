/** Display formatting: re-exported from core/format.ts (one place for all number formatting). */
export { fmtCd, fmtDeg, fmtDegFixed, fmtLm, fmtLx, fmtM, fmtNumber, fmtPct, fmtSig, fmtStatus, fmtStep, fmtValue, KIND_LABEL, unitFor, type Kind } from '../core/format';

export function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}
