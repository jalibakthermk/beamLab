import type { Keyword, PhotometricDataset } from '../model/dataset';
import { formatAngle, formatValue } from './format';

/**
 * IES LM-63-2002 writer, always Type A (photometric type 3), TILT=NONE,
 * candela multiplier 1, ballast factors 1 (values are absolute candela).
 * Lines end in CR LF and stay under 132 characters.
 */

export type ExportErrorCode = 'NOT_INTENSITY' | 'CONTAINS_NAN';

export class ExportError extends Error {
  override name = 'ExportError';
  readonly code: ExportErrorCode;
  constructor(code: ExportErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface IesExportOptions {
  /** Significant digits for candela values. Default 7. */
  precision?: number;
}

const MAX_LINE = 120; // well under the 132-character limit

function keywordLines(key: string, value: string): string[] {
  const out: string[] = [];
  const parts = value.split('\n');
  parts.forEach((part, i) => {
    const tag = i === 0 ? `[${key}]` : '[MORE]';
    const room = MAX_LINE - tag.length - 1;
    if (part.length <= room) {
      out.push(part === '' ? tag : `${tag} ${part}`);
      return;
    }
    for (let p = 0; p < part.length; p += room) {
      out.push(`${p === 0 ? tag : '[MORE]'} ${part.slice(p, p + room)}`);
    }
  });
  return out;
}

function wrapTokens(tokens: string[]): string[] {
  const lines: string[] = [];
  let line = '';
  for (const t of tokens) {
    if (line && line.length + 1 + t.length > MAX_LINE) {
      lines.push(line);
      line = t;
    } else {
      line = line ? `${line} ${t}` : t;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function exportIes(dataset: PhotometricDataset, options: IesExportOptions = {}): string {
  if (dataset.kind !== 'intensity') {
    throw new ExportError(
      'NOT_INTENSITY',
      `Only intensity datasets can be exported as IES; "${dataset.name}" is kind '${dataset.kind}'. Use CSV export instead.`,
    );
  }
  const nanCount = dataset.values.reduce((n, x) => (Number.isFinite(x) ? n : n + 1), 0);
  if (nanCount) {
    throw new ExportError(
      'CONTAINS_NAN',
      `"${dataset.name}" has ${nanCount} point(s) without data (NaN); IES cannot represent missing values. ` +
        'Crop to the covered region or fill the gaps explicitly before exporting.',
    );
  }
  const precision = options.precision ?? 7;
  const { h, v } = dataset.grid;
  const meta = dataset.meta;

  const kws: Keyword[] = meta.keywords.map((k) => (k.key === 'LABEL' ? { key: 'OTHER', value: k.value } : k));
  if (!kws.some((k) => k.key === 'TEST')) kws.unshift({ key: 'TEST', value: 'not specified' });
  if (!kws.some((k) => k.key === 'MANUFAC')) kws.splice(1, 0, { key: 'MANUFAC', value: 'not specified' });
  if (dataset.provenance) kws.push({ key: '_PROVENANCE', value: JSON.stringify(dataset.provenance) });

  const dims = meta.dimensions;
  const units = dims?.units === 'feet' ? 1 : 2;
  const lines: string[] = ['IESNA:LM-63-2002'];
  for (const k of kws) lines.push(...keywordLines(k.key, k.value));
  lines.push('TILT=NONE');
  lines.push(
    [1, meta.lumens ?? -1, 1, v.length, h.length, 3, units, dims?.width ?? 0, dims?.length ?? 0, dims?.height ?? 0]
      .map(String)
      .join(' '),
  );
  lines.push(`1 1 ${meta.watts}`);
  lines.push(...wrapTokens(v.map(formatAngle)));
  lines.push(...wrapTokens(h.map(formatAngle)));
  for (let ih = 0; ih < h.length; ih++) {
    const plane: string[] = [];
    for (let iv = 0; iv < v.length; iv++) plane.push(formatValue(dataset.values[iv * h.length + ih]!, precision));
    lines.push(...wrapTokens(plane));
  }
  return lines.join('\r\n') + '\r\n';
}
