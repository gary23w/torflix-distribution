import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../lib/github.mjs';

test('a no-op update does not create a commit or move the branch', async t => {
  const calls = [];
  const replies = [
    { object: { sha: 'parent' } }, { tree: { sha: 'unchanged' } },
    { sha: 'blob' }, { sha: 'unchanged' },
  ];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([url, init]);
    return new Response(JSON.stringify(replies.shift()), { status: 200 });
  });
  const sha = await new GitHub('test-token').commitFiles('owner/repo', 'main', { 'manifest.json': '{}' }, 'Update');
  assert.equal(sha, 'parent');
  assert.equal(calls.length, 4);
  assert.ok(!calls.some(([url]) => url.endsWith('/git/commits')));
});
test('branch updates preserve the existing tree and use a non-forced ref update', async t => {
  const calls = [], replies = [
    { object: { sha: 'parent' } }, { tree: { sha: 'old-tree' } },
    { sha: 'blob' }, { sha: 'new-tree' }, { sha: 'next' }, {},
  ];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([url, init]);
    return new Response(JSON.stringify(replies.shift()), { status: 200 });
  });
  await new GitHub('test-token').commitFiles('owner/repo', 'main', { 'manifest.json': '{}' }, 'Update');
  assert.deepEqual(JSON.parse(calls[3][1].body), {
    base_tree: 'old-tree', tree: [{ path: 'manifest.json', mode: '100644', type: 'blob', sha: 'blob' }],
  });
  assert.deepEqual(JSON.parse(calls[4][1].body).parents, ['parent']);
  assert.equal(calls[5][1].method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[5][1].body), { sha: 'next', force: false });
});
test('file reads decode UTF-8 and URL-encode release refs', async t => {
  let called;
  t.mock.method(globalThis, 'fetch', async url => {
    called = url;
    return new Response(JSON.stringify({ type: 'file', encoding: 'base64', sha: 'blob', content: Buffer.from('é\n').toString('base64') }));
  });
  const file = await new GitHub('test-token').file('owner/repo', 'LICENSE', 'branch/name');
  assert.equal(file.text, 'é\n');
  assert.ok(called.endsWith('?ref=branch%2Fname'));
});
test('only an explicitly allowed missing file returns null; permission errors fail', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 404 }));
  assert.equal(await new GitHub('test-token').file('owner/repo', 'missing', 'main', true), null);
  await assert.rejects(new GitHub('test-token').file('owner/repo', 'missing', 'main'), /HTTP 404/);
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 403 }));
  await assert.rejects(new GitHub('test-token').file('owner/repo', 'missing', 'main', true), /HTTP 403/);
});
