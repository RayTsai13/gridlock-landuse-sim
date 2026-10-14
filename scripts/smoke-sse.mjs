// Local integration check. Starts no services; changes playback on the local backend.
import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:8000';
const session = await fetch(base + '/api/session', { method: 'POST' });
assert(session.ok);
const cookie = session.headers.get('set-cookie').split(';')[0];
const request = (url, options = {}) => fetch(url, { ...options, headers: { ...options.headers, Cookie: cookie } });
const json = async (path, body) => {
  const res = await request(base + path, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  assert(res.ok, `${path}: ${res.status}`);
  return res.json();
};
const initial = await (await request(base + '/api/playback')).json();
const controllers = [];
const peopleIds = [];
async function openStream() {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await request(base + '/api/heatmap/stream', {signal: controller.signal});
  assert(response.ok);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return async function nextBlock() {
    while (!buffer.includes('\n\n')) {
      const {value, done} = await reader.read();
      assert(!done, 'stream closed early');
      buffer += decoder.decode(value, {stream: true});
    }
    const end = buffer.indexOf('\n\n');
    const block = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    return block;
  };
}
const watchdog = setTimeout(() => {
  for (const controller of controllers) controller.abort();
}, 20000);
try {
  await json('/api/playback', {is_playing: false});
  for (const count of [1, 10, 100]) {
    const start = performance.now();
    const readers = await Promise.all(Array.from({length: count}, openStream));
    const frames = await Promise.all(readers.map(async (next) => {
      const blocks = [];
      for (let i = 0; i < 4; i++) blocks.push(await next());
      assert(blocks[0].includes('event: config'));
      assert(blocks[3].includes('event: frame'));
      return blocks[3].split('data: ')[1];
    }));
    assert.equal(new Set(frames).size, 1, 'readers received different paused frames');
    await Promise.all(readers.map(async (next) => assert.equal(await next(), ': heartbeat')));
    console.log(`${count} readers: identical frame + idle heartbeat verified in ${Math.round(performance.now() - start)} ms`);
    for (const controller of controllers.splice(0)) controller.abort();
  }
  const next = await openStream();
  for (let i = 0; i < 4; i++) await next();
  const response = await json('/api/people/batch', {
    people: Array.from({length: 12}, () => ({lat: 47.606, lon: -122.333, count: 400})),
  });
  peopleIds.push(...response.people.map((p) => p.id));
  let block;
  do { block = await next(); } while (block.startsWith(':'));
  assert(block.includes('event: frame'), 'batch did not wake paused stream');
  assert.equal(response.people.reduce((sum, p) => sum + p.count, 0), 4800);
  console.log('Atomic crowd batch wakes paused stream; total count preserved');
} finally {
  clearTimeout(watchdog);
  for (const controller of controllers) controller.abort();
  for (const id of peopleIds) await request(`${base}/api/people/${id}`, {method: 'DELETE'});
  await json('/api/playback', {is_playing: initial.is_playing});
}
