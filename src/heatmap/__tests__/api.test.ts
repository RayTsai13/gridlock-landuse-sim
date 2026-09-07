import { afterEach, expect, it, vi } from 'vitest';
import { postPeopleBatch } from '../api.ts';

afterEach(() => vi.unstubAllGlobals());
it('sends one request for all crowd clusters and surfaces atomic rejection', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({people: []}) });
  vi.stubGlobal('fetch', fetchMock);
  const people = Array.from({length: 12}, () => ({lat: 47.6, lon: -122.33, count: 400}));
  await postPeopleBatch(people);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe('/api/people/batch');
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).people).toEqual(people);
  fetchMock.mockResolvedValue({ok: false, status: 400});
  await expect(postPeopleBatch(people)).rejects.toThrow('400');
});
