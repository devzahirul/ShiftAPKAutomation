import { createHash } from 'node:crypto';

const origin = 'https://androidpublisher.googleapis.com';

class PlayError extends Error {
  constructor(method, status, detail) {
    super(`Google Play ${method} failed (HTTP ${status}): ${detail}`);
    this.status = status;
  }
}

export async function hashArtifact(artifact) {
  const hash = createHash('sha256');
  for await (const chunk of artifact.stream()) hash.update(chunk);
  return hash.digest('hex');
}

export async function publishInternal({
  packageName, accessToken, artifact, format, sha256, signal,
}, send = fetch) {
  const app = `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}`;
  const resource = format === 'apk' ? 'apks' : 'bundles';
  const artifactHash = item => (format === 'apk' ? item.binary?.sha256 : item.sha256)?.toLowerCase();

  async function request(method, path, { json, media, timeout = 30_000, cleanup = false } = {}) {
    const headers = { Authorization: `Bearer ${accessToken}` };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (media !== undefined) {
      headers['Content-Type'] = 'application/octet-stream';
      body = media;
    }
    const deadline = AbortSignal.timeout(timeout);
    const response = await send(origin + path, {
      method, headers, body, redirect: 'error',
      signal: cleanup ? deadline : AbortSignal.any([signal, deadline]),
    });
    if (response.status === 204) return {};
    const content = await response.text();
    let data;
    try {
      data = content ? JSON.parse(content) : {};
    } catch {
      if (response.ok) throw new Error('Google Play returned an unreadable response.');
    }
    if (!response.ok) {
      throw new PlayError(method, response.status, data?.error?.message ?? response.statusText);
    }
    return data;
  }

  const { id } = await request('POST', `${app}/edits`, { json: {} });
  if (typeof id !== 'string' || !id) throw new Error('Google Play did not return an edit ID.');
  const edit = `${app}/edits/${encodeURIComponent(id)}`;
  let discard = true;
  try {
    const { tracks } = await request('GET', `${edit}/tracks`);
    const internal = tracks?.filter(track => ['internal', 'qa'].includes(track.track));
    if (internal?.length !== 1) {
      throw new Error('Could not uniquely identify the internal testing track. Check its setup in Play Console.');
    }
    const track = internal[0];
    const releases = track.releases ?? [];
    const active = releases[0];
    if (releases.length > 1 || (active && (
      active.status !== 'completed' || active.versionCodes?.length !== 1
    ))) {
      throw new Error('The internal testing track has a pending or complex release. Resolve it in Play Console before using Shift.');
    }

    const inventory = await request('GET', `${edit}/${resource}`);
    let uploaded = inventory[resource]?.find(item => artifactHash(item) === sha256);
    if (!uploaded) {
      uploaded = await request('POST', `/upload${edit}/${resource}?uploadType=media`, {
        media: artifact, timeout: 15 * 60_000,
      });
    }
    if (!Number.isSafeInteger(uploaded.versionCode) || uploaded.versionCode <= 0 ||
        artifactHash(uploaded) !== sha256) {
      throw new Error('The artifact returned by Google Play did not match the local build.');
    }
    const versionCode = String(uploaded.versionCode);
    const result = { packageName, track: track.track, versionCode, sha256 };
    const previousVersion = active?.versionCodes[0];
    if (previousVersion === versionCode) return { ...result, state: 'already_assigned' };
    if (previousVersion && Number(previousVersion) > uploaded.versionCode) {
      throw new Error(`Version ${versionCode} is older than internal testing version ${previousVersion}.`);
    }

    const trackPath = `/tracks/${encodeURIComponent(track.track)}`;
    await request('PUT', edit + trackPath, {
      json: { track: track.track, releases: [{ versionCodes: [versionCode], status: 'completed' }] },
    });
    await request('POST', `${edit}:validate`);

    async function observedState() {
      const { releases: summaries } = await request('GET', `${app}${trackPath}/releases`, {
        timeout: 10_000,
      });
      return summaries?.find(release =>
        release.activeArtifacts?.some(item => String(item.versionCode) === versionCode)
      )?.releaseLifecycleState;
    }

    discard = false;
    try {
      await request('POST', `${edit}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`, { timeout: 120_000 });
    } catch (error) {
      if (error instanceof PlayError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        discard = true;
        throw error;
      }
      const state = await observedState().catch(() => undefined);
      if (state && !state.endsWith('_DRAFT') && !state.endsWith('_UNSPECIFIED')) {
        return { ...result, state, reconciled: true };
      }
      throw new Error(`Could not confirm the commit. Check version ${versionCode} on ${track.track} in Play Console before retrying.`, { cause: error });
    }
    return { ...result, state: await observedState().catch(() => undefined) ?? 'committed' };
  } finally {
    if (discard) {
      try {
        await request('DELETE', edit, { cleanup: true, timeout: 10_000 });
      } catch (error) {
        if (error.status !== 404 && error.status !== 410) {
          console.warn(`Could not discard Google Play edit ${id}: ${error.message}`);
        }
      }
    }
  }
}
