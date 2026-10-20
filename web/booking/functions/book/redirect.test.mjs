import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redirectTarget, onRequest } from './[slug].js';

test('301 from the API becomes a 301 to the new booking path', () => {
  assert.equal(redirectTarget('old-name', 301, '/public/book/new-name'), '/book/new-name');
  assert.equal(redirectTarget('old-name', 200, null), null);
  assert.equal(redirectTarget('old-name', 410, null), null);
  assert.equal(redirectTarget('old-name', 301, 'https://evil.example/x'), null);
  assert.equal(redirectTarget('Bad_Slug', 301, '/public/book/new-name'), null);
});

test('onRequest redirects with 301 and otherwise serves the app', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 301, headers: { Location: '/public/book/al-noor' } });
    const next = () => new Response('app', { status: 200 });
    const ctx = { params: { slug: 'old-noor' }, env: { API_ORIGIN: 'https://api.example' }, request: new Request('https://medlink.website/book/old-noor'), next };
    const r = await onRequest(ctx);
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('Location'), 'https://medlink.website/book/al-noor');

    globalThis.fetch = async () => new Response('{}', { status: 200 });
    assert.equal(await (await onRequest(ctx)).text(), 'app');
    globalThis.fetch = async () => { throw new Error('down'); };
    assert.equal(await (await onRequest(ctx)).text(), 'app');
  } finally {
    globalThis.fetch = realFetch;
  }
});
