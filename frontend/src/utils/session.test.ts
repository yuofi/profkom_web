import { describe, expect, it } from 'vitest';
import { createFixtures } from '../mocks/fixtures';
import { accessFingerprint, can, isActiveSession } from './session';
import { moscowInput, toUtc } from './dates';
import { targetRoute } from './routes';
describe('Session gates and navigation', () => {
  it('keeps approval distinct from login and legacy admin flags', () => {
    expect(isActiveSession(createFixtures('pending').session)).toBe(false);
    expect(isActiveSession(createFixtures('archived').session)).toBe(false);
    expect(isActiveSession(createFixtures('organizer').session)).toBe(true);
    expect(can({ capabilities: [] }, 'view_kkr')).toBe(false);
    expect(can(createFixtures('hr-deputy').session, 'view_kkr')).toBe(false);
  });
  it('changes the access identity when an assignment is withdrawn', () => {
    const { session } = createFixtures('leader'); const before = accessFingerprint(session);
    session.assignments = []; expect(accessFingerprint(session)).not.toBe(before);
  });
  it('encodes object IDs and rejects unknown notification targets', () => {
    expect(targetRoute({ kind: 'task', id: 'a/b?x=1' })).toBe('/tasks/a%2Fb%3Fx%3D1');
    expect(targetRoute({ kind: 'javascript:alert(1)', id: 'x' })).toBeNull();
    expect(targetRoute({ kind: '__proto__', id: 'x' })).toBeNull();
  });
  it('round trips Moscow inputs without depending on the machine timezone', () => {
    expect(moscowInput('2026-10-25T15:00:00Z')).toBe('2026-10-25T18:00');
    expect(toUtc('2026-10-25T18:00')).toBe('2026-10-25T15:00:00.000Z');
  });
});
