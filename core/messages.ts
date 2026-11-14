import { IesParseError, type IesErrorCode, type IesWarningCode } from './io/ies';
import { ExportError, type ExportErrorCode } from './io/export';
import { OperationError, type OperationErrorCode } from './ops/arithmetic';
import { GridError, type GridErrorCode } from './geometry/resample';
import { RotationError } from './geometry/rotate';
import { AimError, type AimErrorCode } from './ops/aim';
import { EngineError, type EngineErrorCode } from './regs/engine';
import { RegulationError } from './regs/schema';
import { RequirementsError } from './road/requirements';
import { RoadError } from './road/illuminance';
import { DatasetError } from './model/dataset';
import { SettingsError } from './settings';

/**
 * Every warning and error code the tool can show, with plain-language text and
 * a suggested action (Phase 8). The UI shows these instead of raw exception
 * text. Codes are namespaced by the part of the tool that raises them.
 */

export type Severity = 'error' | 'warning' | 'info';
export interface MessageInfo {
  severity: Severity;
  text: string;
  action: string;
}

type Table<K extends string> = Record<K, MessageInfo>;
const e = (text: string, action: string): MessageInfo => ({ severity: 'error', text, action });
const w = (text: string, action: string): MessageInfo => ({ severity: 'warning', text, action });
const i = (text: string, action: string): MessageInfo => ({ severity: 'info', text, action });

const IES_WARNINGS: Table<IesWarningCode> = {
  UNKNOWN_FORMAT_VERSION: w('The first line does not name a known LM-63 version; the file is read as LM-63-1986.', 'Check the values against the source if the file looks wrong.'),
  NON_KEYWORD_LINE: i('A header line is not a [KEYWORD] line; it is kept as a label.', 'None needed.'),
  TILT_INCLUDE_IGNORED: i('The file includes TILT data; lamp tilt factors are not applied.', 'None needed for automotive lamps.'),
  TILT_FILE_NOT_LOADED: w('The file refers to a separate TILT file, which is not loaded.', 'None needed for automotive lamps.'),
  TOKEN_COUNT_MISMATCH: w('The candela table has more or fewer numbers than the header says.', 'Check that the file is complete; missing values are treated as no data.'),
  NON_NUMERIC_VALUE: w('Some candela values are not numbers; they are treated as no data.', 'Check the file in a text editor.'),
  ANGLES_NOT_ASCENDING: w('Angles were not in ascending order; they were sorted.', 'Check the values against the source.'),
  DUPLICATE_ANGLE: w('An angle appears twice; one copy was kept.', 'Check the values against the source.'),
  NEGATIVE_CANDELA: w('The file has negative candela values; they are kept as they are.', 'Check the measurement; use Manipulate → Clamp if negatives must be zero.'),
  NONPOSITIVE_FACTOR: w('A multiplier or ballast factor is zero or negative.', 'Check the header values of the file.'),
  FUTURE_USE_FACTOR_APPLIED: i('The "future use" (ballast-lamp) factor is not 1 and was applied to all values.', 'Check that this is intended.'),
  UNKNOWN_UNITS: w('The units code is neither feet nor metres.', 'Only the lamp dimensions are affected; candela values are unchanged.'),
  ANGLE_OUT_OF_RANGE: w('Some angles are outside the valid range and were ignored.', 'Check the angle lists in the file.'),
  RANGE_SMALLER_THAN_STANDARD: i('The file covers a smaller angular range than usual.', 'Directions outside the range are treated as no data.'),
  NONSTANDARD_RANGE: i('The angular range is not one of the standard LM-63 ranges.', 'None needed if this is intended.'),
  SYMMETRY_EXPANDED: i('A symmetric file was expanded to the full range.', 'None needed.'),
  POSSIBLE_SYMMETRY_NOT_EXPANDED: w('The file looks like half of a symmetric distribution but was not expanded.', 'Check the angle range; use Manipulate or the source tool to complete it.'),
  NON_TYPE_A_AXIS_ASSUMPTION: w('Type B or C: the mapping of its axes onto the vehicle is an assumption (docs/conventions.md).', 'Check the plot against a reference viewer before relying on it.'),
  RESAMPLED_TO_TYPE_A: i('The file was converted to Type A H-V angles by interpolation.', 'None needed.'),
  RESAMPLE_STEP_COARSENED: w('The conversion to Type A used a coarser step than the source to keep the grid manageable.', 'Fine details such as a cut-off may be smoothed; prefer a Type A source file.'),
};

const IES_ERRORS: Table<IesErrorCode> = {
  NO_TILT_LINE: e('This is not a readable IES file: there is no TILT= line.', 'Check that the file is an LM-63 photometric file.'),
  UNEXPECTED_END: e('The file ends before all values were read.', 'The file may be truncated; export it again from the source.'),
  NON_NUMERIC_HEADER: e('A header value that must be a number is not a number.', 'Check the lines after TILT= in a text editor.'),
  NON_NUMERIC_ANGLE: e('An angle is not a number.', 'Check the angle lists in the file.'),
  BAD_ANGLE_COUNT: e('The number of angles is not valid.', 'Check the header counts in the file.'),
  BAD_PHOTOMETRIC_TYPE: e('The photometric type is not 1, 2 or 3 (Type C, B or A).', 'Check the header of the file.'),
  NO_DATA_IN_RANGE: e('The file has no data in the valid angular range.', 'Check the angle lists in the file.'),
  NO_DATA_AFTER_CONVERSION: e('No data is left after converting to Type A.', 'Check the angle range of the file.'),
};

const OPERATION: Table<OperationErrorCode> = {
  KIND: e('This operation is not possible for these kinds of dataset (for example intensity × intensity).', 'Choose datasets of the kinds the operation accepts.'),
  BAD_SCALE: e('The scale factor must be a number of 0 or more.', 'Enter a non-negative number.'),
  BAD_WEIGHTS: e('The weights must be numbers.', 'Enter numbers for both weights.'),
  BAD_FLOOR: e('The denominator floor must be a positive number.', 'Enter a positive floor in cd.'),
  BAD_WINDOW: e('The window limits are not valid.', 'Enter min below max for H and V.'),
  NO_OVERLAP: e('The two datasets do not overlap.', 'Use the union extent, or choose datasets that cover the same directions.'),
  GRID_TOO_LARGE: e('The combined grid would be too large for the browser.', 'Use datasets with coarser steps or a smaller range.'),
};

const GRID: Table<GridErrorCode> = {
  NO_OVERLAP: OPERATION.NO_OVERLAP,
  GRID_TOO_LARGE: OPERATION.GRID_TOO_LARGE,
};

const AIM: Table<AimErrorCode> = {
  NO_CUTOFF: e('No clear cut-off was found in the scan window.', 'Check the scan H and V window on the Cut-off tab.'),
  NO_ELBOW: e('The elbow of the cut-off could not be located.', 'Widen the trace H range on the Cut-off tab, or untick "elbow at H = 0".'),
};

const ENGINE: Table<EngineErrorCode> = {
  NOT_INTENSITY: e('Regulation checks need an intensity dataset (cd).', 'Select an intensity dataset in the workspace.'),
  MIRROR_NOT_ALLOWED: e('This regulation file does not allow mirroring for left-hand traffic.', 'Use right-hand traffic, or a file written for left-hand traffic.'),
  BAD_CONDITIONS: e('The test conditions are not valid.', 'Enter a scale factor above 0 and a whole number of lamps.'),
  AIM_NOT_ALLOWED: e('This regulation file does not allow the chosen aim mode.', 'Choose an aim mode the file allows.'),
  AIM_MISSING_VALUE: e('The regulation file gives no nominal cut-off position, so it cannot aim to the cut-off.', 'Use "as loaded", or complete the file.'),
};

const EXPORT: Table<ExportErrorCode> = {
  NOT_INTENSITY: e('Only intensity datasets can be exported as IES.', 'Export a difference, ratio or mask as CSV instead.'),
  CONTAINS_NAN: e('The dataset has directions without data, which IES cannot store.', 'Export as CSV, or limit the dataset to its covered range first.'),
};

const OTHER = {
  'ROTATE.GRID_TOO_LARGE': e('The rotated grid would be too large for the browser.', 'Use the same grid as the input, or a smaller rotation.'),
  'REG.INVALID': e('The regulation file is not valid.', 'Fix the listed fields; see docs/adding-a-regulation.md.'),
  'REQ.INVALID': e('The requirement file is not valid.', 'Fix the listed fields; see data/requirements/template.json.'),
  'ROAD.INPUT': e('A road input is missing or not valid.', 'Complete the highlighted fields on the Road tab.'),
  'DATASET.INVALID': e('The data cannot form a valid dataset.', 'Check the file; report it if it loads in other tools.'),
  'FILE.NOT_IES': e('This is not an .ies file.', 'Choose a file with the .ies extension.'),
  'FILE.TOO_LARGE': e('The file is larger than 50 MB.', 'Use a smaller file or a coarser export.'),
  'FILE.UNREADABLE': e('The file could not be read.', 'Check that the file is not open or locked elsewhere and try again.'),
  'FILE.NOT_JSON': e('The file is not valid JSON.', 'Check the file in a text editor.'),
  'SETTINGS.INVALID': e('The settings file is not valid.', 'Use a file exported from beamLab.'),
  'SETTINGS.NEWER': w('The settings file was written by a newer beamLab version; some settings may be ignored.', 'Check the settings after import.'),
  'SETTINGS.FILE_MISSING': i('The settings refer to files that are not loaded.', 'Load the listed files again; they are matched by their SHA-256.'),
  'SETTINGS.HASH_MISMATCH': w('A loaded file has the expected name but different content (SHA-256).', 'Load the original file; the settings are not applied to a different file.'),
  'WORKER.FAILED': w('The background calculation could not start; calculating on the page instead.', 'None needed; the page may pause on large grids.'),
  'APP.UNEXPECTED': e('Something went wrong in beamLab.', 'Try again; if it happens again, note the steps and report it.'),
} satisfies Record<string, MessageInfo>;

const prefix = <K extends string>(p: string, t: Table<K>): Record<string, MessageInfo> =>
  Object.fromEntries(Object.entries(t).map(([k, v]) => [`${p}.${k}`, v as MessageInfo]));

/** All codes: IESW (parser warnings), IES (parser errors), OP, GRID, AIM, ENGINE, EXPORT and the rest. */
export const MESSAGES: Readonly<Record<string, MessageInfo>> = Object.freeze({
  ...prefix('IESW', IES_WARNINGS),
  ...prefix('IES', IES_ERRORS),
  ...prefix('OP', OPERATION),
  ...prefix('GRID', GRID),
  ...prefix('AIM', AIM),
  ...prefix('ENGINE', ENGINE),
  ...prefix('EXPORT', EXPORT),
  ...OTHER,
});

export interface UserMessage extends MessageInfo {
  code: string;
  /**
   * Specific detail written by beamLab's own checks (e.g. which field is missing).
   * Never the text of an unexpected exception.
   */
  detail: string | null;
  /** Field-by-field problems (validation errors). */
  problems: string[];
}

export function message(code: string, detail: string | null = null, problems: string[] = []): UserMessage {
  const info = MESSAGES[code] ?? MESSAGES['APP.UNEXPECTED']!;
  return { code: MESSAGES[code] ? code : 'APP.UNEXPECTED', ...info, detail, problems };
}

/** Plain-language message for anything thrown. Unknown errors give APP.UNEXPECTED without their text. */
export function toUserMessage(err: unknown): UserMessage {
  if (err instanceof IesParseError) return message(`IES.${err.code}`, err.message);
  if (err instanceof OperationError) return message(`OP.${err.code}`, err.message);
  if (err instanceof GridError) return message(`GRID.${err.code}`, err.message);
  if (err instanceof RotationError) return message('ROTATE.GRID_TOO_LARGE', err.message);
  if (err instanceof AimError) return message(`AIM.${err.code}`, err.message);
  if (err instanceof EngineError) return message(`ENGINE.${err.code}`, err.message);
  if (err instanceof ExportError) return message(`EXPORT.${err.code}`, err.message);
  if (err instanceof RegulationError) return message('REG.INVALID', null, err.problems);
  if (err instanceof RequirementsError) return message('REQ.INVALID', null, err.problems);
  if (err instanceof RoadError) return message('ROAD.INPUT', err.message.replace(/^./, (c) => c.toUpperCase()));
  if (err instanceof SettingsError) return message('SETTINGS.INVALID', null, err.problems);
  if (err instanceof DatasetError) return message('DATASET.INVALID', err.message);
  if (err instanceof SyntaxError) return message('FILE.NOT_JSON');
  return message('APP.UNEXPECTED');
}

/** One line for the UI: text, detail and action. */
export function messageText(m: UserMessage): string {
  return [m.text, m.detail ? `(${m.detail.replace(/\.$/, '')}.)` : '', m.problems.length ? `\n- ${m.problems.join('\n- ')}\n` : '', m.action].filter(Boolean).join(' ').replace(/ \n/g, '\n');
}
