import { describe, expect, it } from 'vitest';
import { monthDays, moscowDay } from './calendar';
describe('Moscow calendar boundaries', () => {
  it('uses Monday columns, leap days and the full Moscow month', () => {
    const february = monthDays('2024-02'); expect(february.days).toHaveLength(29); expect(february.offset).toBe(3);
    expect(february.from).toBe('2024-01-31T21:00:00.000Z'); expect(february.to).toBe('2024-02-29T20:59:59.999Z');
  });
  it('puts an evening UTC event on the next Moscow day', () => {
    expect(moscowDay('2026-10-18T22:00:00Z')).toBe('2026-10-19');
    expect(monthDays('2027-01').days[0]).toBe('2027-01-01');
  });
});
