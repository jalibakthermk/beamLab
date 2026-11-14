/**
 * Provenance of a dataset: which operation produced it, from which inputs,
 * with which parameters. Section 3.1 of FRAMEWORK.md.
 */
export interface Provenance {
  /** Operation name, e.g. 'import', 'resample'. */
  op: string;
  /** Ids of the input datasets (empty for a file import). */
  inputs: string[];
  /** Every parameter needed to reproduce the operation. */
  params: Record<string, unknown>;
  /** ISO 8601 time the dataset was created. */
  timestamp: string;
}

export function makeProvenance(
  op: string,
  inputs: string[],
  params: Record<string, unknown>,
  timestamp: string = new Date().toISOString(),
): Provenance {
  return { op, inputs: [...inputs], params, timestamp };
}
