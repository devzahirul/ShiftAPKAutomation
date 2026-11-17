import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashArtifact, publishInternal } from './play.mjs';

const artifact = new Blob(['signed artifact fixture']);
const sha256 = await hashArtifact(artifact);
const published = 'RELEASE_LIFECYCLE_STATE_PUBLISHED';
const edit = '/androidpublisher/v3/applications/com.example.app/edits/edit-1';
const summary = '/androidpublisher/v3/applications/com.example.app/tracks/internal/releases';
const upload = '/upload' + edit + '/bundles?uploadType=media';
const commit = edit + ':commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW';

function mockPlay({
  commitResult = {}, artifactHash = sha256, alreadyAssigned = false,
  track = 'internal', format = 'aab',
} = {}) {
  const calls = [];
  const resource = format === 'apk' ? 'apks' : 'bundles';
  const metadata = {
    versionCode: 142,
    ...(format === 'apk' ? { binary: { sha256: artifactHash } } : { sha256: artifactHash }),
  };
  const replies = new Map([
    ['POST ' + edit.replace('/edit-1', ''), { id: 'edit-1' }],
    ['GET ' + edit + '/tracks', { tracks: [{
      track,
      releases: [{ versionCodes: [alreadyAssigned ? '142' : '141'], status: 'completed' }],
    }, { track: 'production' }] }],
    ['GET ' + edit + '/' + resource, { [resource]: alreadyAssigned ? [metadata] : [] }],
    ['POST /upload' + edit + '/' + resource + '?uploadType=media', metadata],
    ['PUT ' + edit + '/tracks/' + track, {}],
    ['POST ' + edit + ':validate', {}],
    ['POST ' + commit, commitResult],
    ['GET ' + summary.replace('/tracks/internal/', `/tracks/${track}/`), { releases: [{
      activeArtifacts: [{ versionCode: 142 }], releaseLifecycleState: published,
    }] }],
    ['DELETE ' + edit, {}],
  ]);
  const run = () => publishInternal({
    packageName: 'com.example.app', accessToken: 'fixture', artifact, format, sha256,
    signal: new AbortController().signal,
  }, async (url, options) => {
    const key = options.method + ' ' + url.replace('https://androidpublisher.googleapis.com', '');
    calls.push({ key, body: options.body });
    assert(replies.has(key), key);
    const reply = replies.get(key);
    if (reply instanceof Error) throw reply;
    if (reply instanceof Response) return reply;
    return Response.json(reply);
  });
  return { calls, run };
}

test('build artifact is uploaded, validated and committed to internal testing', async () => {
  const { calls, run } = mockPlay();
  const result = await run();
  assert.equal(result.versionCode, '142');
  assert.equal(result.state, published);
  assert.equal(calls.find(call => call.key === 'POST ' + upload).body, artifact);
  assert.deepEqual(JSON.parse(calls.find(call => call.key.startsWith('PUT ')).body), {
    track: 'internal', releases: [{ versionCodes: ['142'], status: 'completed' }],
  });
  assert.deepEqual(calls.slice(-3).map(call => call.key), [
    'POST ' + edit + ':validate', 'POST ' + commit, 'GET ' + summary,
  ]);
});

test('a legacy APK is uploaded to the APK endpoint and the discovered qa track', async () => {
  const { calls, run } = mockPlay({ format: 'apk', track: 'qa' });
  assert.equal((await run()).track, 'qa');
  assert(calls.some(call => call.key === 'POST /upload' + edit + '/apks?uploadType=media'));
  assert(calls.some(call => call.key === 'PUT ' + edit + '/tracks/qa'));
});

test('a repeated artifact already assigned to internal testing is a no-op', async () => {
  const { calls, run } = mockPlay({ alreadyAssigned: true });
  assert.equal((await run()).state, 'already_assigned');
  assert.equal(calls.length, 4);
  assert.equal(calls.at(-1).key, 'DELETE ' + edit);
});

test('a hash mismatch discards the edit without changing the track', async () => {
  const { calls, run } = mockPlay({ artifactHash: 'bad-digest' });
  await assert.rejects(run, /did not match the local build/);
  assert.equal(calls.some(call => call.key.startsWith('PUT ')), false);
  assert.equal(calls.at(-1).key, 'DELETE ' + edit);
});

test('a rejected commit discards the edit without resubmitting the review', async () => {
  const { calls, run } = mockPlay({
    commitResult: Response.json({ error: { message: 'Changes already in review' } }, { status: 400 }),
  });
  await assert.rejects(run, /Changes already in review/);
  assert.equal(calls.filter(call => call.key.includes(':commit')).length, 1);
  assert.equal(calls.at(-1).key, 'DELETE ' + edit);
});

test('a lost commit response is reconciled by reading release status', async () => {
  const { calls, run } = mockPlay({ commitResult: new Error('disconnected') });
  assert.equal((await run()).reconciled, true);
  assert.equal(calls.at(-1).key, 'GET ' + summary);
});

test('the production option exits before signing in, building, or publishing', () => {
  const script = fileURLToPath(new URL('./shift.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--target', 'production'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Production is disabled/);
  assert.equal(result.stdout, '');
});
