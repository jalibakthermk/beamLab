import type { PhotometricDataset } from '../model/dataset';
import { formatAngle, formatValue } from './format';

/**
 * CSV matrix: first row "V\H" then the H angles; each following row is one
 * V angle (ascending) followed by its values. NaN is written as an empty cell.
 * Any dataset kind may be exported.
 */
export function exportCsv(dataset: PhotometricDataset, options: { precision?: number } = {}): string {
  const precision = options.precision ?? 7;
  const { h, v } = dataset.grid;
  const rows = [['V\\H', ...h.map(formatAngle)].join(',')];
  for (let iv = 0; iv < v.length; iv++) {
    const cells = [formatAngle(v[iv]!)];
    for (let ih = 0; ih < h.length; ih++) {
      const x = dataset.values[iv * h.length + ih]!;
      cells.push(Number.isFinite(x) ? formatValue(x, precision) : '');
    }
    rows.push(cells.join(','));
  }
  return rows.join('\n') + '\n';
}
