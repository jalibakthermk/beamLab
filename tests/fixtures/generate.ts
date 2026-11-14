/**
 * Synthetic IES fixture generator with known answers (FRAMEWORK.md section 10).
 *
 * Self-contained on purpose: it does not import anything from core/, so the
 * fixtures are an independent check of the parser. It uses only erasable
 * TypeScript so Node can run it directly:  npm run fixtures
 *
 * Direction formulas here follow the default AXIS_ASSUMPTIONS documented in
 * core/geometry/coords.ts, re-written independently.
 */

const D2R = Math.PI / 180;

export interface IesSpec {
  /** First line, e.g. 'IESNA:LM-63-2002'; null for LM-63-1986 (no header line). */
  header: string | null;
  /** Raw lines between the header and the TILT line. */
  keywordLines: string[];
  tilt?: string;
  /** Raw lines following TILT=INCLUDE. */
  tiltData?: string[];
  lamps?: number;
  lumensPerLamp?: number;
  multiplier?: number;
  /** 1 = C, 2 = B, 3 = A */
  type: 1 | 2 | 3;
  units?: 1 | 2;
  width?: number;
  length?: number;
  height?: number;
  ballast?: number;
  /** Ballast-lamp photometric factor (1986/1991) or "future use" (1995+). */
  blpf?: number;
  watts?: number;
  /** Vertical angles in file order. */
  v: number[];
  /** Horizontal angles in file order. */
  h: number[];
  /** Value written to the file for (h, v). */
  cd: (h: number, v: number) => number;
  decimals?: number;
  eol?: string;
  /** 'messy' joins numeric tokens with mixed spaces, commas, tabs and line breaks. */
  layout?: 'standard' | 'messy';
  dropTokens?: number;
  extraTokens?: string[];
}

export function fmt(x: number, decimals: number): string {
  const s = String(Number(x.toFixed(decimals)));
  return s === '-0' ? '0' : s;
}

function wrap(tokens: string[], perLine = 10): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += perLine) out.push(tokens.slice(i, i + perLine).join(' '));
  return out;
}

export function writeIes(s: IesSpec): string {
  const dec = s.decimals ?? 3;
  const eol = s.eol ?? '\r\n';
  const head: string[] = [];
  if (s.header !== null) head.push(s.header);
  head.push(...s.keywordLines);
  head.push(`TILT=${s.tilt ?? 'NONE'}`);
  if (s.tiltData) head.push(...s.tiltData);

  const line1 = [
    s.lamps ?? 1,
    s.lumensPerLamp ?? -1,
    s.multiplier ?? 1,
    s.v.length,
    s.h.length,
    s.type,
    s.units ?? 2,
    s.width ?? 0.2,
    s.length ?? 0.3,
    s.height ?? 0.1,
  ].map(String);
  const line2 = [s.ballast ?? 1, s.blpf ?? 1, s.watts ?? 55].map(String);
  const vTok = s.v.map((x) => fmt(x, 6));
  const hTok = s.h.map((x) => fmt(x, 6));
  const cdTok: string[] = [];
  for (const h of s.h) for (const v of s.v) cdTok.push(fmt(s.cd(h, v), dec));

  let numericTokens = [...line1, ...line2, ...vTok, ...hTok, ...cdTok];
  if (s.dropTokens) numericTokens = numericTokens.slice(0, numericTokens.length - s.dropTokens);
  if (s.extraTokens) numericTokens = [...numericTokens, ...s.extraTokens];

  let body: string[];
  if (s.layout === 'messy') {
    const seps = [' ', ',', ', ', '  ', '\t', eol, `,${eol}`, ' ,', `${eol}  `];
    let seed = 7;
    let text = numericTokens[0] ?? '';
    for (let i = 1; i < numericTokens.length; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      text += seps[seed % seps.length]! + numericTokens[i]!;
    }
    body = [text];
  } else {
    const n1 = line1.length;
    const n2 = line2.length;
    const rest = numericTokens.slice(n1 + n2);
    const nv = vTok.length;
    const nh = hTok.length;
    body = [
      numericTokens.slice(0, n1).join(' '),
      numericTokens.slice(n1, n1 + n2).join(' '),
      ...wrap(rest.slice(0, nv)),
      ...wrap(rest.slice(nv, nv + nh)),
    ];
    const cdRest = rest.slice(nv + nh);
    for (let i = 0; i < cdRest.length; i += nv) body.push(...wrap(cdRest.slice(i, i + nv)));
  }
  return [...head, ...body].join(eol) + eol;
}

export function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  const n = Math.round((to - from) / step);
  for (let i = 0; i <= n; i++) out.push(Number((from + i * step).toFixed(9)));
  return out;
}

// ── Expected answers ───────────────────────────────────────────────────────

/** Small Type A grid shared by the format variants and malformed files. */
export const VARIANT_H = [-10, -5, 0, 5, 10];
export const VARIANT_V = [-5, 0, 5];
export const variantCd = (h: number, v: number): number => 1000 + 10 * h + 3 * v + 0.5 * h * v;

export const UNIFORM_SPHERE_CD = 1000;
export const UNIFORM_LIMITED = { cd: 500, hMin: -45, hMax: 45, vMin: -15, vMax: 15 };

export const GAUSS = { peak: 20000, h0: 10, v0: -3, sh: 3, sv: 1.5 };
export const gaussCd = (h: number, v: number): number =>
  GAUSS.peak * Math.exp(-((h - GAUSS.h0) ** 2) / (2 * GAUSS.sh ** 2) - (v - GAUSS.v0) ** 2 / (2 * GAUSS.sv ** 2));

/** Hot spot right-up at (+20, +5); weaker spot left-down at (-15, -10). */
export const asymmetricCd = (h: number, v: number): number =>
  100 +
  5000 * Math.exp(-((h - 20) ** 2 + (v - 5) ** 2) / 32) +
  1000 * Math.exp(-((h + 15) ** 2 + (v + 10) ** 2) / 32);

export const halfSymmetricCd = (h: number, v: number): number => 1000 - 5 * Math.abs(h) + 2 * (v + 90);

/** One physical beam, as a function of the vehicle-frame direction [forward, right, up]. */
export const sameBeam = (x: number, y: number, z: number): number => 2000 + 1000 * x + 400 * y + 300 * z;

export function dirTypeA(h: number, v: number): [number, number, number] {
  return [Math.cos(v * D2R) * Math.cos(h * D2R), Math.cos(v * D2R) * Math.sin(h * D2R), Math.sin(v * D2R)];
}
/** Type B, default assumptions: zero = forward, H+ = right, V+ = up. */
export function dirTypeB(h: number, v: number): [number, number, number] {
  return [Math.cos(h * D2R) * Math.cos(v * D2R), Math.sin(h * D2R), Math.cos(h * D2R) * Math.sin(v * D2R)];
}
/** Type C, default assumptions: nadir = down, C0 = forward, C90 = left. */
export function dirTypeC(c: number, g: number): [number, number, number] {
  return [Math.sin(g * D2R) * Math.cos(c * D2R), -Math.sin(g * D2R) * Math.sin(c * D2R), -Math.cos(g * D2R)];
}

/**
 * Smooth low beam with a sharp cut-off, peak on a file node at (H 2, V -0.6).
 * Layout copies a real automotive Type B file: H -90..90 at 2°, V -40..40 with a
 * 0.1° band from -10 to 5. Regression fixture for the Phase 2 resampling-step fix.
 */
export const FINE_CUTOFF = { peak: 36000, h0: 2, v0: -0.6 };
export const fineCutoffH = range(-90, 90, 2);
export const fineCutoffV = [...range(-40, -11, 1), ...range(-10, 5, 0.1), ...range(6, 40, 1)];
export const fineCutoffCd = (h: number, v: number): number => {
  const g = v <= FINE_CUTOFF.v0 ? Math.exp((v - FINE_CUTOFF.v0) / 1.5) : Math.exp(-(v - FINE_CUTOFF.v0) * 6);
  return 50 + FINE_CUTOFF.peak * Math.exp(-((h - FINE_CUTOFF.h0) ** 2) / 50) * g;
};

/**
 * Cut-off fixtures (Phase 5). log10 I = BASE − H_CURV·H² − A·(1 − s(V − c(H))), with the
 * sigmoid s(x) = 1 / (1 + e^(x / W)): intensity drops by A decades across the cut-off at c(H).
 * G(V) = log10 I(V) − log10 I(V + 0.1) = A·[s(V − c) − s(V + 0.1 − c)] is largest at
 * V = c − 0.05 (the midpoint V + 0.05 sits on c), with Gmax = A·tanh(0.05 / (2W)).
 */
export const CUTOFF = { BASE: 4, H_CURV: 0.002, A: 2.5, W: 0.15, DELTA: 0.1 };
export const sigmoid = (x: number): number => 1 / (1 + Math.exp(x / CUTOFF.W));
export const cutoffGmax = (a = CUTOFF.A): number => a * Math.tanh(CUTOFF.DELTA / 2 / (2 * CUTOFF.W));
/** Measured cut-off V for a sigmoid centred on c. */
export const measuredCut = (c: number): number => c - CUTOFF.DELTA / 2;
export const cutoffLog = (h: number, v: number, c: number): number =>
  CUTOFF.BASE - CUTOFF.H_CURV * h * h - CUTOFF.A * (1 - sigmoid(v - c));

/** Plain horizontal cut-off centred at V0 = -0.52, so the measured cut-off is at -0.57° (1% down). */
export const PLAIN_V0 = -0.52;
/** Kinked RHT beam: horizontal left of the elbow, 15° shoulder rising to the right. */
export const KINK = { V0: -0.25, he: 1, angle: 15 };
export const kinkC = (h: number): number => KINK.V0 + Math.max(0, h - KINK.he) * Math.tan((KINK.angle * Math.PI) / 180);
/** Mirror image (LHT): elbow at H = -1, shoulder rising to the left. */
export const kinkCMirror = (h: number): number => kinkC(-h);
/** Noisy plain beam: ±0.01 decade noise and a weaker second step (1 decade) centred at V = +1. */
export const NOISE = { amplitude: 0.01, secondA: 1, secondC: 1 };
export const CUT_H = range(-12, 12, 0.5);
export const CUT_V_FINE = range(-5, 3, 0.05);
export const CUT_V_COARSE = range(-5, 3, 0.25);

function noise(h: number, v: number): number {
  // deterministic hash noise in [-1, 1]
  const x = Math.sin(h * 12.9898 + v * 78.233) * 43758.5453;
  return 2 * (x - Math.floor(x)) - 1;
}

/**
 * Road fixture (Phase 7): asymmetric low-beam-like spot, peak 20000 cd at H +3°, V -1.5°,
 * on 100 cd background; H -45..45 at 1°, V -15..10 at 0.25°. Used for the golden comparison
 * with Road-illuminate.
 */
export const ROAD_BEAM = { peak: 20000, h0: 3, v0: -1.5, sh: 8, sv: 1.2, base: 100 };
export const roadBeamCd = (h: number, v: number): number =>
  ROAD_BEAM.base + ROAD_BEAM.peak * Math.exp(-((h - ROAD_BEAM.h0) ** 2) / (2 * ROAD_BEAM.sh ** 2) - (v - ROAD_BEAM.v0) ** 2 / (2 * ROAD_BEAM.sv ** 2));

export const MULTIPLIER_CASE = { multiplier: 2.5, ballast: 0.9, blpf: 1.1 };
export const FUTURE_USE_FACTOR = 1.2;

// ── Fixtures ────────────────────────────────────────────────────────────────

const K2002 = ['[TEST] BL-2002', '[TESTLAB] beamLab', '[MANUFAC] beamLab synthetic'];

function variant(header: string | null, keywordLines: string[], extra: Partial<IesSpec> = {}): string {
  return writeIes({ header, keywordLines, type: 3, v: VARIANT_V, h: VARIANT_H, cd: variantCd, ...extra });
}

export function buildFixtures(): Record<string, string> {
  const f: Record<string, string> = {};

  // Physics fixtures
  f['uniform-sphere-typeC.ies'] = writeIes({
    header: 'IESNA:LM-63-2002',
    keywordLines: [...K2002, '[_FIXTURE] uniform intensity, full sphere, Type C'],
    type: 1,
    h: range(0, 360, 30),
    v: range(0, 180, 10),
    cd: () => UNIFORM_SPHERE_CD,
  });
  f['uniform-limited-typeA.ies'] = writeIes({
    header: 'IESNA:LM-63-2002',
    keywordLines: [...K2002, '[_FIXTURE] uniform intensity, H -45..45, V -15..15'],
    type: 3,
    h: range(UNIFORM_LIMITED.hMin, UNIFORM_LIMITED.hMax, 5),
    v: range(UNIFORM_LIMITED.vMin, UNIFORM_LIMITED.vMax, 1),
    cd: () => UNIFORM_LIMITED.cd,
  });
  f['gaussian-spot-typeA.ies'] = writeIes({
    header: 'IESNA:LM-63-2002',
    keywordLines: [...K2002, '[_FIXTURE] Gaussian spot, peak 20000 cd at H=+10, V=-3'],
    type: 3,
    h: range(-30, 30, 0.5),
    v: range(-15, 10, 0.5),
    cd: gaussCd,
  });
  f['asymmetric-typeA.ies'] = writeIes({
    header: 'IESNA:LM-63-2002',
    keywordLines: [...K2002, '[_FIXTURE] asymmetric: hot spot right-up (+20,+5), weak spot left-down (-15,-10)'],
    type: 3,
    h: range(-40, 40, 2),
    v: range(-20, 20, 2),
    cd: asymmetricCd,
  });
  f['symmetric-half-typeA.ies'] = writeIes({
    header: 'IESNA:LM-63-2002',
    keywordLines: [...K2002, '[_FIXTURE] laterally symmetric, H 0..90 only'],
    type: 3,
    h: range(0, 90, 10),
    v: range(-90, 90, 10),
    cd: halfSymmetricCd,
  });

  // Same physical beam in Types A, B and C
  f['same-beam-typeA.ies'] = writeIes({
    header: 'IESNA:LM-63-2002',
    keywordLines: [...K2002, '[_FIXTURE] same beam, Type A'],
    type: 3,
    h: range(-90, 90, 3),
    v: range(-90, 90, 3),
    cd: (h, v) => sameBeam(...dirTypeA(h, v)),
    decimals: 4,
  });
  f['same-beam-typeB.ies'] = writeIes({
    header: 'IESNA:LM-63-2002',
    keywordLines: [...K2002, '[_FIXTURE] same beam, Type B'],
    type: 2,
    h: range(-90, 90, 3),
    v: range(-90, 90, 3),
    cd: (h, v) => sameBeam(...dirTypeB(h, v)),
    decimals: 4,
  });
  f['same-beam-typeC.ies'] = writeIes({
    header: 'IESNA:LM-63-2002',
    keywordLines: [...K2002, '[_FIXTURE] same beam, Type C'],
    type: 1,
    h: range(0, 360, 5),
    v: range(0, 180, 3),
    cd: (c, g) => sameBeam(...dirTypeC(c, g)),
    decimals: 4,
  });

  f['fine-cutoff-typeB.ies'] = writeIes({
    header: 'IESNA:LM-63-2002',
    keywordLines: [...K2002, '[_FIXTURE] Type B low beam, 0.1 deg cut-off band, peak node at H=2, V=-0.6'],
    type: 2,
    h: fineCutoffH,
    v: fineCutoffV,
    cd: fineCutoffCd,
    decimals: 2,
  });

  // Cut-off fixtures (Phase 5)
  const cut = (name: string, v: number[], c: (h: number) => number, extra: (h: number, v: number) => number = () => 0, note = '') => {
    f[name] = writeIes({
      header: 'IESNA:LM-63-2002',
      keywordLines: [...K2002, `[_FIXTURE] ${note}`],
      type: 3,
      h: CUT_H,
      v,
      cd: (hh, vv) => 10 ** (cutoffLog(hh, vv, c(hh)) + extra(hh, vv)),
      decimals: 4,
    });
  };
  cut('cutoff-plain-fine.ies', CUT_V_FINE, () => PLAIN_V0, undefined, 'sigmoid cut-off centred at V=-0.52 (measured -0.57), 0.05 deg V step');
  cut('cutoff-plain-coarse.ies', CUT_V_COARSE, () => PLAIN_V0, undefined, 'same beam on a 0.25 deg V step');
  cut('cutoff-kink-rht.ies', CUT_V_FINE, kinkC, undefined, 'RHT kinked cut-off: elbow at H=1, 15 deg shoulder to the right');
  cut('cutoff-kink-lht.ies', CUT_V_FINE, kinkCMirror, undefined, 'LHT mirror: elbow at H=-1, 15 deg shoulder to the left');
  cut(
    'cutoff-plain-noisy.ies',
    CUT_V_FINE,
    () => PLAIN_V0,
    (hh, vv) => NOISE.amplitude * noise(hh, vv) - NOISE.secondA * (1 - sigmoid(vv - NOISE.secondC)),
    'plain cut-off with noise and a second, weaker step at V=+1',
  );

  f['road-beam-typeA.ies'] = writeIes({
    header: 'IESNA:LM-63-2002',
    keywordLines: [...K2002, '[_FIXTURE] road beam: spot 20000 cd at H +3, V -1.5 on 100 cd, H -45..45 at 1 deg, V -15..10 at 0.25 deg'],
    type: 3,
    h: range(-45, 45, 1),
    v: range(-15, 10, 0.25),
    cd: roadBeamCd,
    decimals: 3,
  });

  // Format variants: all describe VARIANT_H × VARIANT_V with variantCd
  f['format-lm63-1986.ies'] = variant(null, ['beamLab synthetic fixture', 'LM-63-1986 variant, no header line'], {
    lumensPerLamp: 1000,
  });
  f['format-lm63-1991.ies'] = variant('IESNA91', ['[TEST] BL-1991', '[MANUFAC] beamLab synthetic'], {
    lumensPerLamp: 1000,
    eol: '\n',
  });
  f['format-lm63-1995.ies'] = variant('IESNA:LM-63-1995', [
    '[TEST] BL-1995',
    '[MANUFAC] beamLab synthetic',
    '[LUMCAT] V-1995',
    '[MORE] continued catalogue text',
  ]);
  f['format-lm63-2002.ies'] = variant('IESNA:LM-63-2002', [...K2002, '[_FIXTURE] lm63-2002']);
  f['format-lm63-2019.ies'] = variant('IES:LM-63-2019', [
    '[TEST] BL-2019',
    '[TESTLAB] beamLab',
    '[ISSUEDATE] 2026-11-14',
    '[MANUFAC] beamLab synthetic',
    '[LUMCAT] V-2019',
    '[OTHER] first line',
    '[MORE] second line',
  ]);
  f['format-mixed-separators.ies'] = variant('IESNA:LM-63-2002', [...K2002], { layout: 'messy' });
  f['format-multiplier-ballast.ies'] = variant('IESNA91', ['[TEST] BL-MULT', '[MANUFAC] beamLab synthetic'], {
    ...MULTIPLIER_CASE,
    cd: (h, v) =>
      variantCd(h, v) / (MULTIPLIER_CASE.multiplier * MULTIPLIER_CASE.ballast * MULTIPLIER_CASE.blpf),
    decimals: 9,
  });
  f['format-future-use-factor.ies'] = variant('IESNA:LM-63-2002', [...K2002], {
    blpf: FUTURE_USE_FACTOR,
    cd: (h, v) => variantCd(h, v) / FUTURE_USE_FACTOR,
    decimals: 9,
  });
  f['format-tilt-include.ies'] = variant('IESNA:LM-63-2002', [...K2002], {
    tilt: 'INCLUDE',
    tiltData: ['1', '3', '0 45 90', '1.0 0.95 0.90'],
  });
  f['format-tilt-file.ies'] = variant('IESNA:LM-63-1995', ['[TEST] BL-TILTFILE', '[MANUFAC] beamLab synthetic'], {
    tilt: 'lamp.tlt',
  });

  // Malformed
  f['malformed-token-short.ies'] = variant('IESNA:LM-63-2002', [...K2002], { dropTokens: 4 });
  f['malformed-token-long.ies'] = variant('IESNA:LM-63-2002', [...K2002], { extraTokens: ['1', '2', '3'] });
  f['malformed-non-ascending.ies'] = variant('IESNA:LM-63-2002', [...K2002], {
    h: [-10, -5, 5, 0, 10],
    v: [5, 0, -5],
  });
  f['malformed-negative-candela.ies'] = variant('IESNA:LM-63-2002', [...K2002], {
    cd: (h, v) => (h === 5 && v === 0 ? -50 : variantCd(h, v)),
  });

  return f;
}
