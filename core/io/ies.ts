import {
  createDataset,
  type Keyword,
  type PhotometricDataset,
  type PhotometricType,
  type SourceFormat,
} from '../model/dataset';
import { makeProvenance } from '../model/provenance';
import { fnv1a } from '../model/hash';
import { AXIS_ASSUMPTIONS, type AxisAssumptions } from '../geometry/coords';
import { resampleToTypeA } from '../geometry/resample';

/**
 * IES LM-63 reader (1986, 1991, 1995, 2002, 2019).
 *
 * Throws IesParseError only when the file cannot be read at all (no TILT
 * line, header or angles missing/non-numeric, unknown photometric type).
 * Everything recoverable is returned as a structured warning.
 */

export type IesWarningCode =
  | 'UNKNOWN_FORMAT_VERSION'
  | 'NON_KEYWORD_LINE'
  | 'TILT_INCLUDE_IGNORED'
  | 'TILT_FILE_NOT_LOADED'
  | 'TOKEN_COUNT_MISMATCH'
  | 'NON_NUMERIC_VALUE'
  | 'ANGLES_NOT_ASCENDING'
  | 'DUPLICATE_ANGLE'
  | 'NEGATIVE_CANDELA'
  | 'NONPOSITIVE_FACTOR'
  | 'FUTURE_USE_FACTOR_APPLIED'
  | 'UNKNOWN_UNITS'
  | 'ANGLE_OUT_OF_RANGE'
  | 'RANGE_SMALLER_THAN_STANDARD'
  | 'NONSTANDARD_RANGE'
  | 'SYMMETRY_EXPANDED'
  | 'POSSIBLE_SYMMETRY_NOT_EXPANDED'
  | 'NON_TYPE_A_AXIS_ASSUMPTION'
  | 'RESAMPLED_TO_TYPE_A'
  | 'RESAMPLE_STEP_COARSENED';

export interface IesWarning {
  code: IesWarningCode;
  message: string;
  severity: 'info' | 'warning';
}

export type IesErrorCode =
  | 'NO_TILT_LINE'
  | 'UNEXPECTED_END'
  | 'NON_NUMERIC_HEADER'
  | 'NON_NUMERIC_ANGLE'
  | 'BAD_ANGLE_COUNT'
  | 'BAD_PHOTOMETRIC_TYPE'
  | 'NO_DATA_IN_RANGE'
  | 'NO_DATA_AFTER_CONVERSION';

export class IesParseError extends Error {
  override name = 'IesParseError';
  readonly code: IesErrorCode;
  constructor(code: IesErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface IesParseOptions {
  /** Dataset id. Default: hash of the file content. */
  id?: string;
  /** Dataset name, e.g. the file name. Default 'untitled.ies'. */
  name?: string;
  /** Mirror left/right (H → -H) after loading. Default false. */
  flipH?: boolean;
  /** Provenance timestamp. Default: now. */
  timestamp?: string;
  /** Axis assumptions for Type B / C. Default AXIS_ASSUMPTIONS. */
  axes?: AxisAssumptions;
}

export interface IesParseResult {
  dataset: PhotometricDataset;
  warnings: IesWarning[];
  /** The data at each parsing stage, for tracing values (diagnostics only; the app does not use it). */
  stages: IesStages;
}

export interface IesStages {
  /** Exactly as written in the file: angles in file order, candela plane by plane ([h][v]), before any scaling. */
  raw: {
    type: PhotometricType;
    hAngles: number[];
    vAngles: number[];
    /** values[ih * vAngles.length + iv]; NaN where a token was missing or not a number. */
    values: Float64Array;
    factors: { multiplier: number; ballastFactor: number; ballastLampFactor: number; total: number };
  };
  /** After sorting, range filtering, scaling to absolute cd and symmetry expansion; still in the file's own type. Row-major [v][h]. */
  source: { type: PhotometricType; h: number[]; v: number[]; values: Float64Array; symmetry: string | null };
}

const KEYWORD_FORMATS: SourceFormat[] = ['LM-63-1991', 'LM-63-1995', 'LM-63-2002', 'LM-63-2019'];
/** Formats where the second factor on line 2 is "future use" rather than the ballast-lamp photometric factor. */
const FUTURE_USE_FORMATS: SourceFormat[] = ['LM-63-1995', 'LM-63-2002', 'LM-63-2019'];

const TYPE_BY_CODE: Record<number, PhotometricType> = { 1: 'C', 2: 'B', 3: 'A' };

/** Absolute angle limits per type: [hMin, hMax, vMin, vMax]. */
const LIMITS: Record<PhotometricType, [number, number, number, number]> = {
  A: [-180, 180, -90, 90],
  B: [-90, 90, -180, 180],
  C: [0, 360, 0, 180],
};


function detectFormat(firstLine: string, warn: (w: IesWarning) => void): { format: SourceFormat; hasHeader: boolean } {
  const t = firstLine.trim();
  const m = /^IES(?:NA)?\s*:\s*LM-63-(\d{4})/i.exec(t);
  if (m) {
    const year = m[1];
    if (year === '1995') return { format: 'LM-63-1995', hasHeader: true };
    if (year === '2002') return { format: 'LM-63-2002', hasHeader: true };
    if (year === '2019') return { format: 'LM-63-2019', hasHeader: true };
    warn({
      code: 'UNKNOWN_FORMAT_VERSION',
      severity: 'warning',
      message: `Unknown format header "${t}"; reading it as LM-63-2002.`,
    });
    return { format: 'LM-63-2002', hasHeader: true };
  }
  if (/^IESNA\s*91/i.test(t)) return { format: 'LM-63-1991', hasHeader: true };
  return { format: 'LM-63-1986', hasHeader: false };
}

class TokenStream {
  pos = 0;
  constructor(private readonly tokens: string[]) {}
  get remaining(): number {
    return this.tokens.length - this.pos;
  }
  next(what: string): string {
    const t = this.tokens[this.pos];
    if (t === undefined) throw new IesParseError('UNEXPECTED_END', `File ended while reading ${what}.`);
    this.pos++;
    return t;
  }
  number(what: string, code: IesErrorCode = 'NON_NUMERIC_HEADER'): number {
    const t = this.next(what);
    const x = Number(t);
    if (!Number.isFinite(x)) throw new IesParseError(code, `Expected a number for ${what}, found "${t}".`);
    return x;
  }
}

/** Sorted, de-duplicated axis with the source index of each kept angle. */
function sortAxis(
  axis: number[],
  label: string,
  warn: (w: IesWarning) => void,
): { angles: number[]; source: number[] } {
  let unsorted = false;
  for (let i = 1; i < axis.length; i++) if (axis[i]! < axis[i - 1]!) unsorted = true;
  const order = axis.map((_, i) => i).sort((a, b) => axis[a]! - axis[b]! || a - b);
  const angles: number[] = [];
  const source: number[] = [];
  let dupes = 0;
  for (const i of order) {
    if (angles.length && axis[i] === angles[angles.length - 1]) {
      dupes++;
      continue;
    }
    angles.push(axis[i]!);
    source.push(i);
  }
  if (unsorted) {
    warn({
      code: 'ANGLES_NOT_ASCENDING',
      severity: 'warning',
      message: `${label} angles are not in ascending order; they were sorted, keeping each candela value with its angle.`,
    });
  }
  if (dupes) {
    warn({
      code: 'DUPLICATE_ANGLE',
      severity: 'warning',
      message: `${dupes} duplicate ${label} angle(s) found; only the first occurrence in the file was kept.`,
    });
  }
  return { angles, source };
}

const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9;

export function parseIes(text: string, options: IesParseOptions = {}): IesParseResult {
  const warnings: IesWarning[] = [];
  const warn = (w: IesWarning) => warnings.push(w);
  const flipH = options.flipH ?? false;
  const axes = options.axes ?? AXIS_ASSUMPTIONS;

  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const { format, hasHeader } = detectFormat(lines[0] ?? '', warn);

  // ── Keyword / label lines up to TILT= ────────────────────────────────
  const keywords: Keyword[] = [];
  let tiltIndex = -1;
  let nonKeyword = 0;
  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (/^TILT\s*=/i.test(t)) {
      tiltIndex = i;
      break;
    }
    if (t === '') continue;
    const m = /^\[([^\]]*)\]\s?(.*)$/.exec(t);
    if (m && KEYWORD_FORMATS.includes(format)) {
      const key = m[1]!.trim().toUpperCase();
      const value = m[2]!.trimEnd(); // keep the value's own leading spaces (e.g. indented text)
      const prev = keywords[keywords.length - 1];
      if (key === 'MORE' && prev) prev.value += `\n${value}`;
      else keywords.push({ key, value });
    } else {
      keywords.push({ key: 'LABEL', value: t });
      if (format !== 'LM-63-1986') nonKeyword++;
    }
  }
  if (nonKeyword) {
    warn({
      code: 'NON_KEYWORD_LINE',
      severity: 'warning',
      message: `${nonKeyword} line(s) before TILT= are not [KEYWORD] lines; kept as LABEL keywords.`,
    });
  }
  if (tiltIndex < 0) throw new IesParseError('NO_TILT_LINE', 'No TILT= line found; this is not a readable IES file.');

  const tiltLine = lines[tiltIndex]!.trim();
  const tiltValue = tiltLine.slice(tiltLine.indexOf('=') + 1).trim();
  const tiltKind = /^NONE$/i.test(tiltValue) ? 'NONE' : /^INCLUDE$/i.test(tiltValue) ? 'INCLUDE' : 'FILE';

  // ── Free-format numeric token stream ────────────────────────────────
  const tokens = new TokenStream(
    lines
      .slice(tiltIndex + 1)
      .join(' ')
      .split(/[\s,]+/)
      .filter((s) => s !== ''),
  );

  if (tiltKind === 'INCLUDE') {
    tokens.number('TILT lamp-to-luminaire geometry');
    const n = tokens.number('TILT number of angle/factor pairs');
    for (let i = 0; i < 2 * n; i++) tokens.number('TILT angles and multiplying factors');
    warn({
      code: 'TILT_INCLUDE_IGNORED',
      severity: 'warning',
      message: `TILT=INCLUDE data (${n} angle/factor pairs) was read and skipped; tilt factors are not applied.`,
    });
  } else if (tiltKind === 'FILE') {
    warn({
      code: 'TILT_FILE_NOT_LOADED',
      severity: 'warning',
      message: `TILT refers to an external file "${tiltValue}", which is not loaded; tilt factors are not applied.`,
    });
  }

  const lamps = tokens.number('number of lamps');
  const lumensPerLamp = tokens.number('lumens per lamp');
  const multiplier = tokens.number('candela multiplier');
  const nV = tokens.number('number of vertical angles');
  const nH = tokens.number('number of horizontal angles');
  const typeCode = tokens.number('photometric type');
  const unitsCode = tokens.number('units type');
  const width = tokens.number('luminous opening width');
  const length = tokens.number('luminous opening length');
  const height = tokens.number('luminous opening height');
  const ballastFactor = tokens.number('ballast factor');
  const ballastLampFactor = tokens.number('ballast-lamp photometric factor / future use');
  const watts = tokens.number('input watts');

  for (const [n, label] of [
    [nV, 'vertical'],
    [nH, 'horizontal'],
  ] as const) {
    if (!Number.isInteger(n) || n < 1) {
      throw new IesParseError('BAD_ANGLE_COUNT', `Number of ${label} angles must be a positive integer, found ${n}.`);
    }
  }
  const type = TYPE_BY_CODE[typeCode];
  if (!type) throw new IesParseError('BAD_PHOTOMETRIC_TYPE', `Photometric type must be 1, 2 or 3, found ${typeCode}.`);

  const units = unitsCode === 1 ? 'feet' : unitsCode === 2 ? 'meters' : 'unknown';
  if (units === 'unknown') {
    warn({ code: 'UNKNOWN_UNITS', severity: 'warning', message: `Units type ${unitsCode} is not 1 (feet) or 2 (meters).` });
  }

  const vRaw: number[] = [];
  for (let i = 0; i < nV; i++) vRaw.push(tokens.number('vertical angles', 'NON_NUMERIC_ANGLE'));
  const hRaw: number[] = [];
  for (let i = 0; i < nH; i++) hRaw.push(tokens.number('horizontal angles', 'NON_NUMERIC_ANGLE'));

  // ── Candela values: one set of nV values per horizontal angle ───────
  const total = nV * nH;
  const available = tokens.remaining;
  const raw = new Float64Array(total).fill(NaN);
  let nonNumeric = 0;
  for (let i = 0; i < Math.min(total, available); i++) {
    const t = tokens.next('candela values');
    const x = Number(t);
    if (Number.isFinite(x)) raw[i] = x;
    else nonNumeric++;
  }
  if (available !== total) {
    warn({
      code: 'TOKEN_COUNT_MISMATCH',
      severity: 'warning',
      message:
        available < total
          ? `Expected ${total} candela values, found ${available}; the missing ${total - available} are set to NaN.`
          : `Expected ${total} candela values, found ${available}; the extra ${available - total} tokens are ignored.`,
    });
  }
  if (nonNumeric) {
    warn({ code: 'NON_NUMERIC_VALUE', severity: 'warning', message: `${nonNumeric} candela value(s) are not numbers; set to NaN.` });
  }

  // ── Sort axes, drop duplicates and out-of-range angles ──────────────
  const vs = sortAxis(vRaw, 'Vertical', warn);
  const hs = sortAxis(hRaw, 'Horizontal', warn);
  const [hLo, hHi, vLo, vHi] = LIMITS[type];
  const keepV = vs.angles.map((a, k) => [a, vs.source[k]!] as const).filter(([a]) => a >= vLo - 1e-9 && a <= vHi + 1e-9);
  const keepH = hs.angles.map((a, k) => [a, hs.source[k]!] as const).filter(([a]) => a >= hLo - 1e-9 && a <= hHi + 1e-9);
  const dropped = vs.angles.length - keepV.length + hs.angles.length - keepH.length;
  if (dropped) {
    warn({
      code: 'ANGLE_OUT_OF_RANGE',
      severity: 'warning',
      message: `${dropped} angle(s) outside the Type ${type} range (H ${hLo}..${hHi}, V ${vLo}..${vHi}) were dropped.`,
    });
  }
  if (!keepV.length || !keepH.length) throw new IesParseError('NO_DATA_IN_RANGE', 'No angles inside the valid range.');

  const vAxis = keepV.map(([a]) => a);
  let hAxis = keepH.map(([a]) => a);
  // planes[k][j] = candela at hAxis[k], vAxis[j]
  let planes = keepH.map(([, ih]) => keepV.map(([, iv]) => raw[ih * nV + iv]!));

  // ── Absolute candela ────────────────────────────────────────────────
  const factor = multiplier * ballastFactor * ballastLampFactor;
  if (!(factor > 0)) {
    warn({
      code: 'NONPOSITIVE_FACTOR',
      severity: 'warning',
      message: `Candela multiplier × ballast factor × ballast-lamp factor = ${factor}, which is not positive.`,
    });
  }
  if (FUTURE_USE_FORMATS.includes(format) && ballastLampFactor !== 1) {
    warn({
      code: 'FUTURE_USE_FACTOR_APPLIED',
      severity: 'warning',
      message: `${format} defines this field as "future use" (should be 1), but it is ${ballastLampFactor}; it was applied as a ballast-lamp photometric factor.`,
    });
  }
  let negatives = 0;
  planes = planes.map((p) =>
    p.map((x) => {
      if (x < 0) negatives++;
      return x * factor;
    }),
  );
  if (negatives) {
    warn({ code: 'NEGATIVE_CANDELA', severity: 'warning', message: `${negatives} negative candela value(s) found; kept as-is.` });
  }

  // ── Standard ranges and symmetry ─────────────────────────────────────
  let symmetry: string | null = null;
  const h0 = hAxis[0]!;
  const h1 = hAxis[hAxis.length - 1]!;
  const v0 = vAxis[0]!;
  const v1 = vAxis[vAxis.length - 1]!;
  const smaller: string[] = [];

  if (type === 'A' || type === 'B') {
    const symmetric = hAxis.length > 1 && eq(h0, 0) && eq(h1, 90);
    if (!symmetric && !(eq(h0, -90) && eq(h1, 90))) {
      if (h0 >= -90 - 1e-9 && h1 <= 90 + 1e-9) smaller.push(`H ${h0}..${h1}`);
      else
        warn({
          code: 'NONSTANDARD_RANGE',
          severity: 'info',
          message: `H range ${h0}..${h1} extends beyond the LM-63 Type ${type} range -90..90.`,
        });
    }
    if (!(eq(v0, -90) && eq(v1, 90))) {
      if (v0 >= -90 - 1e-9 && v1 <= 90 + 1e-9) smaller.push(`V ${v0}..${v1}`);
      else
        warn({
          code: 'NONSTANDARD_RANGE',
          severity: 'info',
          message: `V range ${v0}..${v1} extends beyond the LM-63 Type ${type} range -90..90.`,
        });
    }
    if (symmetric) {
      const mirrored = hAxis.slice(1).map((a) => -a).reverse();
      planes = [...planes.slice(1).reverse(), ...planes];
      hAxis = [...mirrored, ...hAxis];
      symmetry = 'lateral (H 0..90 mirrored)';
      warn({
        code: 'SYMMETRY_EXPANDED',
        severity: 'info',
        message: 'Horizontal angles 0..90 only: laterally symmetric file mirrored to -90..90.',
      });
    } else if (eq(h0, 0)) {
      warn({
        code: 'POSSIBLE_SYMMETRY_NOT_EXPANDED',
        severity: 'info',
        message: `Horizontal angles start at 0 but end at ${h1}, not 90; the file was NOT treated as symmetric. Data covers H ${h0}..${h1} only.`,
      });
    }
  } else {
    // Type C
    const vStd = (eq(v0, 0) && eq(v1, 90)) || (eq(v0, 90) && eq(v1, 180)) || (eq(v0, 0) && eq(v1, 180));
    if (!vStd) smaller.push(`γ ${v0}..${v1}`);
    let map: Array<[number, number]> | null = null; // [C angle, plane index]
    if (hAxis.length === 1) {
      map = [
        [0, 0],
        [360, 0],
      ];
      symmetry = 'rotational (single plane)';
    } else if (eq(h0, 0) && eq(h1, 90)) {
      map = hAxis.flatMap((c, k): Array<[number, number]> => [
        [c, k],
        [180 - c, k],
        [180 + c, k],
        [360 - c, k],
      ]);
      symmetry = 'quadrant (C 0..90 mirrored)';
    } else if (eq(h0, 0) && eq(h1, 180)) {
      map = hAxis.flatMap((c, k): Array<[number, number]> => [
        [c, k],
        [360 - c, k],
      ]);
      symmetry = 'bilateral about the C0-C180 plane';
    } else if (eq(h0, 90) && eq(h1, 270)) {
      map = hAxis.flatMap((c, k): Array<[number, number]> => {
        const m = (((180 - c) % 360) + 360) % 360;
        const out: Array<[number, number]> = [
          [c, k],
          [m, k],
        ];
        if (eq(m, 0)) out.push([360, k]);
        return out;
      });
      symmetry = 'bilateral about the C90-C270 plane';
    } else if (!(eq(h0, 0) && eq(h1, 360))) {
      smaller.push(`C ${h0}..${h1}`);
    }
    if (map) {
      const byAngle = new Map<string, [number, number]>();
      for (const [c, k] of map) {
        const key = c.toFixed(9);
        if (!byAngle.has(key)) byAngle.set(key, [Number(key), k]);
      }
      const entries = [...byAngle.values()].sort((a, b) => a[0] - b[0]);
      hAxis = entries.map(([c]) => c);
      const src = planes;
      planes = entries.map(([, k]) => src[k]!);
      warn({ code: 'SYMMETRY_EXPANDED', severity: 'info', message: `Type C ${symmetry}: expanded to C 0..360.` });
    }
  }
  if (smaller.length) {
    warn({
      code: 'RANGE_SMALLER_THAN_STANDARD',
      severity: 'info',
      message: `Angular range smaller than the LM-63 standard range (${smaller.join(', ')}); coverage is set to the real range.`,
    });
  }

  // ── Row-major [v][h] values in the file's own type ─────────────────
  const values = new Float64Array(vAxis.length * hAxis.length);
  for (let iv = 0; iv < vAxis.length; iv++) {
    for (let ih = 0; ih < hAxis.length; ih++) values[iv * hAxis.length + ih] = planes[ih]![iv]!;
  }

  const stages: IesStages = {
    raw: {
      type,
      hAngles: [...hRaw],
      vAngles: [...vRaw],
      values: raw.slice(),
      factors: { multiplier, ballastFactor, ballastLampFactor, total: factor },
    },
    source: { type, h: [...hAxis], v: [...vAxis], values: values.slice(), symmetry },
  };

  // ── Convert to canonical Type A ─────────────────────────────────────
  let grid = { h: hAxis, v: vAxis };
  let canonical: Float64Array = values;
  let conversion: Record<string, unknown> | null = null;
  if (type !== 'A') {
    const res = resampleToTypeA({ type, h: hAxis, v: vAxis, values }, { axes });
    if (!res) throw new IesParseError('NO_DATA_AFTER_CONVERSION', `Type ${type} data could not be mapped to Type A.`);
    grid = res.grid;
    canonical = res.values;
    conversion = {
      from: type,
      targetStep: res.step,
      requestedStep: res.requestedStep,
      interpolation: 'bilinear',
      axisAssumptions: type === 'B' ? axes.B : axes.C,
    };
    warn({
      code: 'NON_TYPE_A_AXIS_ASSUMPTION',
      severity: 'warning',
      message:
        type === 'B'
          ? 'Type B file: assumed H = 0, V = 0 is forward, H+ is right and V+ is up (see AXIS_ASSUMPTIONS). Check the result against a reference.'
          : 'Type C file: assumed γ = 0 is down, C = 0 is forward and C = 90 is left (see AXIS_ASSUMPTIONS). Check the result against a reference.',
    });
    warn({
      code: 'RESAMPLED_TO_TYPE_A',
      severity: 'info',
      message: `Converted from Type ${type} to Type A by bilinear resampling on a ${res.step}° grid.`,
    });
    if (res.coarsened) {
      warn({
        code: 'RESAMPLE_STEP_COARSENED',
        severity: 'warning',
        message: `Source step ${res.requestedStep}° would need too many points; resampled at ${res.step}° instead.`,
      });
    }
  }

  if (flipH) {
    const nHc = grid.h.length;
    const flipped = new Float64Array(canonical.length);
    for (let iv = 0; iv < grid.v.length; iv++) {
      for (let ih = 0; ih < nHc; ih++) flipped[iv * nHc + ih] = canonical[iv * nHc + (nHc - 1 - ih)]!;
    }
    grid = { h: grid.h.map((a) => (a === 0 ? 0 : -a)).reverse(), v: grid.v };
    canonical = flipped;
  }

  const dataset = createDataset({
    id: options.id ?? `ies-${fnv1a(text)}${flipH ? '-flipH' : ''}`,
    name: options.name ?? 'untitled.ies',
    kind: 'intensity',
    grid,
    values: canonical,
    meta: {
      keywords,
      lumens: lumensPerLamp > 0 ? lamps * lumensPerLamp : null,
      multiplier,
      ballastFactor,
      ballastLampFactor,
      watts,
      dimensions: { width, length, height, units },
      sourceType: type,
      sourceFormat: format,
    },
    provenance: makeProvenance(
      'import',
      [],
      { format, photometricType: type, tilt: tiltKind, flipH, symmetry, conversion },
      options.timestamp,
    ),
  });
  return { dataset, warnings, stages };
}
