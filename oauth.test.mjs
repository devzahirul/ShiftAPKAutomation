import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { signIn } from './oauth.mjs';

test('desktop sign-in rejects a mismatched state and exchanges the valid code with PKCE', async t => {
  t.mock.method(console, 'log', () => {});
  const cancellation = new AbortController();
  const redirects = Promise.withResolvers();
  const client = {
    client_id: 'fixture.apps.googleusercontent.com', client_secret: 'fixture',
  };
  let authorization;
  const pending = signIn(client, cancellation.signal, {
    launch(url) {
      authorization = new URL(url);
      redirects.resolve(authorization);
    },
    async exchange(url, request) {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(request.body.get('code'), 'valid-code');
      assert.equal(request.body.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
      assert.equal(
        createHash('sha256').update(request.body.get('code_verifier')).digest('base64url'),
        authorization.searchParams.get('code_challenge'),
      );
      return Response.json({ access_token: 'fixture-token', expires_in: 3600 });
    },
  });
  try {
    const authUrl = await Promise.race([redirects.promise, pending]);
    assert.equal(authUrl.origin, 'https://accounts.google.com');
    const callback = new URL(authUrl.searchParams.get('redirect_uri'));
    assert.equal(callback.hostname, '127.0.0.1');
    callback.search = 'code=invalid-code&state=incorrect';
    assert.equal((await fetch(callback)).status, 400);
    callback.search = new URLSearchParams({
      code: 'valid-code', state: authUrl.searchParams.get('state'),
    }).toString();
    assert.match(await (await fetch(callback)).text(), /sign-in received/);
    assert.equal((await pending).accessToken, 'fixture-token');
  } finally {
    cancellation.abort();
    await pending.catch(() => {});
  }
});
