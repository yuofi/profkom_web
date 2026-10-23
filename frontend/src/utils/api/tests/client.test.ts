import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MockAdapter from 'axios-mock-adapter';
import axios from 'axios';
import Cookies from 'js-cookie';
import { api } from '../index';
import { QueryClient } from '@tanstack/react-query';
import { completeAuthentication, endSession } from '../../authSession';
import { createFixtures } from '../../../mocks/fixtures';

let client: MockAdapter;
let refresh: MockAdapter;
beforeEach(() => { client = new MockAdapter(api); refresh = new MockAdapter(axios); Cookies.remove('access_token'); });
afterEach(() => { client.restore(); refresh.restore(); });
describe('Access token refresh', () => {
  it('shares one refresh between concurrent requests and retries with the new token', async () => {
    Cookies.set('access_token', 'expired');
    let calls = 0;
    refresh.onPost(/\/auth\/refresh$/).reply(async () => { calls++; await Promise.resolve(); return [200, { access_token: 'fresh' }]; });
    client.onGet('/private').reply(config => config.headers?.Authorization === 'Bearer fresh' ? [200, { ok: true }] : [401, {}]);
    const responses = await Promise.all([api.get('/private'), api.get('/private')]);
    expect(calls).toBe(1); expect(responses.map(r => r.status)).toEqual([200, 200]);
  });
  it('clears the access token and stops when refresh fails', async () => {
    Cookies.set('access_token', 'expired'); client.onGet('/private').reply(401);
    refresh.onPost(/\/auth\/refresh$/).reply(401);
    await expect(api.get('/private')).rejects.toThrow(); expect(Cookies.get('access_token')).toBeUndefined();
    expect(client.history.get).toHaveLength(1);
  });
  it('A-ROL-14: a refresh lost to another tab retries with the pair that tab set', async () => {
    Cookies.set('access_token', 'expired');
    refresh.onPost(/\/auth\/refresh$/).reply(() => {
      Cookies.set('access_token', 'from-other-tab');
      return [401, { detail: 'Refresh token not found (revoked or already used)' }];
    });
    client.onGet('/private').reply(config => config.headers?.Authorization === 'Bearer from-other-tab' ? [200, { ok: true }] : [401, {}]);
    expect((await api.get('/private')).status).toBe(200);
    expect(Cookies.get('access_token')).toBe('from-other-tab');
  });
  it('A-ROL-14: tabs refresh one at a time; a tab that waited uses the new pair as is', async () => {
    Cookies.set('access_token', 'expired');
    const names: string[] = [];
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (name: string, task: () => Promise<void>) => {
        names.push(name);
        Cookies.set('access_token', 'from-other-tab'); // the other tab held the lock and refreshed
        return task();
      },
    } });
    try {
      refresh.onPost(/\/auth\/refresh$/).reply(200, { access_token: 'twice' });
      client.onGet('/private').reply(config => config.headers?.Authorization === 'Bearer from-other-tab' ? [200, { ok: true }] : [401, {}]);
      expect((await api.get('/private')).status).toBe(200);
      expect(names).toEqual(['profkom-auth-refresh']);
      expect(refresh.history.post).toHaveLength(0);
    } finally {
      Reflect.deleteProperty(navigator, 'locks');
    }
  });
  it('does not refresh a rejected login', async () => {
    client.onPost('/auth/login').reply(401);
    await expect(api.post('/auth/login')).rejects.toThrow(); expect(refresh.history.post).toHaveLength(0);
  });
  it('does not loop after an unsuccessful retry', async () => {
    client.onGet('/private').reply(401); refresh.onPost(/\/auth\/refresh$/).reply(200, { access_token: 'fresh' });
    await expect(api.get('/private')).rejects.toThrow(); expect(refresh.history.post).toHaveLength(1);
    expect(client.history.get).toHaveLength(2);
  });
  it.each(['login', 'logout'])('A03: a delayed old refresh cannot restore credentials after %s', async (transition) => {
    Cookies.set('access_token', 'old-token');
    let release: (() => void) | undefined;
    refresh.onPost(/\/auth\/refresh$/).reply(() => new Promise((resolve) => { release = () => resolve([200, { access_token: 'stale-refreshed-token' }]); }));
    client.onGet('/old-private').reply(401);
    client.onGet('/session').reply(200, createFixtures('pending').session);
    client.onPost('/auth/logout').reply(200, {});
    const oldRequest = api.get('/old-private').catch((error) => error);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const queries = new QueryClient();
    if (transition === 'login') await completeAuthentication(queries, 'new-account-token');
    else await endSession(queries);
    release!(); await oldRequest;
    expect(Cookies.get('access_token')).toBe(transition === 'login' ? 'new-account-token' : undefined);
    expect(client.history.get.filter((r) => r.url === '/old-private')).toHaveLength(1);
    queries.clear();
  });
});
