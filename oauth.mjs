import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const authorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const scope = 'https://www.googleapis.com/auth/androidpublisher';

export async function readDesktopClient(path) {
  const { installed } = JSON.parse(await readFile(path, 'utf8').then(s => s.replace(/^\uFEFF/, '')));
  if (typeof installed?.client_id !== 'string' ||
      !installed.client_id.endsWith('.apps.googleusercontent.com') ||
      typeof installed.client_secret !== 'string' || !installed.client_secret) {
    throw new Error('Use an OAuth client JSON downloaded for a Google Cloud Desktop app.');
  }
  return installed;
}

function openBrowser(url) {
  const commands = {
    win32: ['rundll32.exe', 'url.dll,FileProtocolHandler'],
    darwin: ['open'],
    linux: ['xdg-open'],
  };
  const command = commands[process.platform];
  if (!command) return;
  const child = spawn(command[0], [...command.slice(1), url], {
    stdio: 'ignore', windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
}

export async function signIn(client, signal, { launch = openBrowser, exchange = fetch } = {}) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const expectedState = Buffer.from(state);
  const callbackPath = '/';
  let resolveCode;
  let rejectCode;
  const code = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = URL.parse(req.url, base);
    const receivedState = Buffer.from(url?.searchParams.get('state') ?? '');
    const validState = receivedState.length === expectedState.length &&
      timingSafeEqual(receivedState, expectedState);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'close');
    if (req.method !== 'GET' || url?.origin !== base || url.pathname !== callbackPath || !validState) {
      res.writeHead(400).end('Invalid sign-in callback.');
      return;
    }
    const authorizationCode = url.searchParams.get('code');
    if (!authorizationCode || url.searchParams.has('error')) {
      res.writeHead(400).end('Sign-in was canceled or declined. Return to the terminal.', () => {
        rejectCode(new Error('Google sign-in was canceled or declined.'));
      });
      return;
    }
    res.end('Google sign-in received. Return to the terminal.', () => resolveCode(authorizationCode));
  });

  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
  function cancelSignIn() {
    rejectCode(new Error('Google sign-in expired or was canceled.'));
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const redirectUri = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    console.log(`Sign in with your Play Console account. If the browser does not open, visit:\n${url}`);
    deadline.addEventListener('abort', cancelSignIn, { once: true });
    if (deadline.aborted) cancelSignIn();
    launch(url.href);
    const response = await exchange(tokenEndpoint, {
      method: 'POST',
      redirect: 'error',
      body: new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret,
        code: await code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: deadline,
    });
    if (!response.ok) throw new Error(`Google rejected the authorization code (HTTP ${response.status}). Try signing in again.`);
    const token = await response.json();
    if (typeof token.access_token !== 'string' || !Number.isFinite(token.expires_in)) {
      throw new Error('Google did not return a usable access token.');
    }
    return { accessToken: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
  } finally {
    deadline.removeEventListener('abort', cancelSignIn);
    server.close();
    server.closeAllConnections();
  }
}
