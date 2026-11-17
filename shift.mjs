#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, openAsBlob } from 'node:fs';
import { extname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { readDesktopClient, signIn } from './oauth.mjs';
import { hashArtifact, publishInternal } from './play.mjs';

const help = `Usage: shift-play --oauth-client PATH [options]

Run inside the Android Gradle project. Shift opens your browser to sign in,
builds the signed release artifact, and asks before sending it to Google Play.

  --oauth-client PATH    Google Cloud Desktop OAuth client JSON (required)
  --package ID           Play application ID, e.g. com.example.app
  --target TARGET        testing or production (production is disabled in v0.1)
  --format FORMAT        aab (default) or apk (eligible legacy apps)
  --task TASK            Full Gradle task for a custom module or variant
  --artifact PATH        Artifact output path for --task
  --help                 Show usage
`;

async function ask(question, signal) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  input.on('SIGINT', () => process.emit('SIGINT'));
  try {
    return (await input.question(question, { signal })).trim();
  } finally {
    input.close();
  }
}

function runGradle(wrapper, task, signal) {
  const isWindows = process.platform === 'win32';
  const command = isWindows ? 'cmd.exe' : `./${wrapper}`;
  const gradleArgs = [task, '--console=plain'];
  const args = isWindows ? ['/d', '/s', '/c', '.\\gradlew.bat', ...gradleArgs] : gradleArgs;
  return new Promise((done, fail) => {
    const build = spawn(command, args, { stdio: 'inherit', signal });
    build.once('error', fail);
    build.once('close', (code, reason) => {
      if (code === 0) done();
      else fail(new Error(`Gradle build failed (${reason ?? `exit ${code}`}).`));
    });
  });
}

function describeState(state) {
  const descriptions = {
    already_assigned: 'Version already assigned to internal testing',
    committed: 'Edit committed. Check Play Console for availability',
    RELEASE_LIFECYCLE_STATE_PUBLISHED: 'Available on internal testing',
    RELEASE_LIFECYCLE_STATE_IN_REVIEW: 'Submitted and in review',
    RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW: 'Awaiting submission in Play Console',
    RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED: 'Approved and awaiting publication in Play Console',
    RELEASE_LIFECYCLE_STATE_NOT_APPROVED: 'Rejected in review. Check Play Console',
    RELEASE_LIFECYCLE_STATE_DRAFT: 'Draft in Play Console',
  };
  return descriptions[state] ?? `Play lifecycle state: ${state}`;
}

async function main(signal) {
  const { values } = parseArgs({
    options: {
      'oauth-client': { type: 'string' },
      package: { type: 'string' },
      target: { type: 'string' },
      format: { type: 'string', default: 'aab' },
      task: { type: 'string' },
      artifact: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  if (values.target === 'production') throw new Error('Production is disabled in v0.1. Choose testing.');
  if (values.target !== undefined && values.target !== 'testing') {
    throw new Error('--target must be testing or production.');
  }
  if (!values['oauth-client']) throw new Error('Pass --oauth-client PATH. Run with --help for usage.');
  if (!process.stdin.isTTY) throw new Error('Run Shift in an interactive terminal to sign in and confirm the release.');

  const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  if (!existsSync(wrapper) || (!existsSync('settings.gradle') && !existsSync('settings.gradle.kts'))) {
    throw new Error(`Run Shift from the Android project root containing ${wrapper} and Gradle settings.`);
  }
  const format = values.format;
  if (format !== 'aab' && format !== 'apk') throw new Error('--format must be aab or apk.');
  if ((values.task === undefined) !== (values.artifact === undefined)) {
    throw new Error('Pass --task and --artifact together for a custom build.');
  }
  const task = values.task ?? (format === 'aab' ? ':app:bundleRelease' : ':app:assembleRelease');
  if (!/^(:[A-Za-z0-9_-]+)+$/.test(task)) {
    throw new Error('Use a full Gradle task path, e.g. :app:bundleRelease.');
  }
  const output = resolve(values.artifact ?? (format === 'aab'
    ? 'app/build/outputs/bundle/release/app-release.aab'
    : 'app/build/outputs/apk/release/app-release.apk'));
  if (extname(output).toLowerCase() !== `.${format}`) {
    throw new Error(`The artifact output must end in .${format}.`);
  }

  if (!values.target) {
    const target = await ask('1. Testing (internal)\n2. Production (disabled in v0.1)\nChoose 1 or 2: ', signal);
    if (target === '2') throw new Error('Production is disabled in v0.1. Choose testing.');
    if (target !== '1') throw new Error('Choose 1 to release to internal testing.');
  }
  const packageName = values.package ?? await ask('Google Play package name: ', signal);
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) {
    throw new Error('Enter a valid Play package name, e.g. com.example.app.');
  }
  const client = await readDesktopClient(values['oauth-client']);
  let token = await signIn(client, signal);
  console.log(`Building ${task} ...`);
  await runGradle(wrapper, task, signal);

  if (!existsSync(output)) {
    throw new Error(`Gradle did not produce ${output}. Configure release signing or specify the correct --task and --artifact.`);
  }
  const artifact = await openAsBlob(output);
  if (!artifact.size) throw new Error(`The Gradle artifact is empty: ${output}`);
  const sha256 = await hashArtifact(artifact);
  console.log(`\nPackage: ${packageName}\nTrack: Internal testing\nArtifact: ${output}\nSHA-256: ${sha256}`);
  console.log('Committing the release may also submit pending changes in Play Console for review.');
  const answer = await ask('Type publish to submit this release: ', signal);
  if (answer !== 'publish') {
    console.log('Release canceled.');
    return;
  }
  if (token.expiresAt - Date.now() < 20 * 60_000) token = await signIn(client, signal);
  const result = await publishInternal({
    packageName, accessToken: token.accessToken, artifact, format, sha256, signal,
  });
  console.log(`Google Play version ${result.versionCode} on ${result.track}. ${describeState(result.state)}.`);
}

const cancellation = new AbortController();
process.on('SIGINT', () => cancellation.abort());
try {
  await main(cancellation.signal);
} catch (error) {
  process.exitCode = cancellation.signal.aborted ? 130 : 1;
  console.error(`Shift: ${error.message}`);
}
