import { describe, expect, it } from 'vitest';
import { MESSAGES, message, messageText, toUserMessage } from '../core/messages';
import { parseIes, IesParseError } from '../core/io/ies';
import { OperationError } from '../core/ops/arithmetic';
import { AimError } from '../core/ops/aim';
import { EngineError } from '../core/regs/engine';
import { ExportError } from '../core/io/export';
import { RegulationError } from '../core/regs/schema';
import { RoadError } from '../core/road/illuminance';
import { fixtureNames, fixture } from './load-fixture';

describe('message table', () => {
  it('every entry has a severity, text and an action', () => {
    expect(Object.keys(MESSAGES).length).toBeGreaterThan(60);
    for (const [code, m] of Object.entries(MESSAGES)) {
      expect(['error', 'warning', 'info'], code).toContain(m.severity);
      expect(m.text.length, code).toBeGreaterThan(10);
      expect(m.action.length, code).toBeGreaterThan(3);
    }
  });

  it('every parser warning raised by the fixtures has an entry', () => {
    for (const name of fixtureNames()) {
      try {
        for (const w of parseIes(fixture(name)).warnings) expect(MESSAGES[`IESW.${w.code}`], w.code).toBeDefined();
      } catch (e) {
        expect(e).toBeInstanceOf(IesParseError);
        expect(MESSAGES[`IES.${(e as IesParseError).code}`]).toBeDefined();
      }
    }
  });

  it('maps every core error class to its code', () => {
    expect(toUserMessage(new OperationError('NO_OVERLAP', 'x')).code).toBe('OP.NO_OVERLAP');
    expect(toUserMessage(new AimError('NO_CUTOFF', 'x')).code).toBe('AIM.NO_CUTOFF');
    expect(toUserMessage(new EngineError('MIRROR_NOT_ALLOWED', 'x')).code).toBe('ENGINE.MIRROR_NOT_ALLOWED');
    expect(toUserMessage(new ExportError('CONTAINS_NAN', 'x')).code).toBe('EXPORT.CONTAINS_NAN');
    expect(toUserMessage(new RegulationError(['id: must be a string']))).toMatchObject({ code: 'REG.INVALID', problems: ['id: must be a string'] });
    expect(toUserMessage(new RoadError('mounting height must be entered'))).toMatchObject({ code: 'ROAD.INPUT', detail: 'Mounting height must be entered' });
    expect(toUserMessage(new SyntaxError('Unexpected token')).code).toBe('FILE.NOT_JSON');
  });

  it('never passes on the text of an unexpected exception', () => {
    const m = toUserMessage(new TypeError("Cannot read properties of undefined (reading 'x')"));
    expect(m.code).toBe('APP.UNEXPECTED');
    expect(messageText(m)).not.toMatch(/undefined|reading/);
    expect(message('NO.SUCH.CODE').code).toBe('APP.UNEXPECTED');
  });
});
