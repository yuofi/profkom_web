import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import MockAdapter from 'axios-mock-adapter';
import axios from 'axios';
import Cookies from 'js-cookie';
import { api } from '../index';

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
  it('does not refresh a rejected login', async () => {
    client.onPost('/auth/login').reply(401);
    await expect(api.post('/auth/login')).rejects.toThrow(); expect(refresh.history.post).toHaveLength(0);
  });
  it('does not loop after an unsuccessful retry', async () => {
    client.onGet('/private').reply(401); refresh.onPost(/\/auth\/refresh$/).reply(200, { access_token: 'fresh' });
    await expect(api.get('/private')).rejects.toThrow(); expect(refresh.history.post).toHaveLength(1);
    expect(client.history.get).toHaveLength(2);
  });
});
