import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GitHub } from './lib/github.mjs';
import { channels, upstream, homepage, versionOf, compareVersions, stableReleases, makePlan, selectedAssets, render } from './lib/releases.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), command = args.shift();
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const readApi = new GitHub(process.env.GH_TOKEN);
const stateRepo = process.env.GITHUB_REPOSITORY || 'gary23w/torflix-distribution';
const localState = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8'));
const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));

async function summary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, text + '\n');
}

async function plan() {
  // Keep the public repository's schedule active even between infrequent app releases.
  const month = new Date().toISOString().slice(0, 7);
  if (process.env.GITHUB_ACTIONS === 'true' && localState._heartbeat !== month) {
    localState._heartbeat = month;
    const file = await readApi.file(stateRepo, 'state.json', 'main');
    const current = JSON.parse(file.text);
    current._heartbeat = month;
    await readApi.request(`repos/${stateRepo}/contents/state.json`, { method: 'PUT', body: {
      branch: 'main', sha: file.sha, message: `Keep release checks active for ${month}`,
      content: Buffer.from(JSON.stringify(current, null, 2) + '\n').toString('base64'),
    } });
  }
  const releases = await readApi.request(`repos/${upstream}/releases?per_page=100`);
  const enabled = Object.fromEntries(channels.map(channel => [channel,
    channel === 'chocolatey' ? process.env.CHOCOLATEY_CONFIGURED === 'true'
      : channel === 'aur' ? process.env.AUR_CONFIGURED === 'true'
        : process.env.GITHUB_PUBLISH_CONFIGURED === 'true']));
  const result = makePlan(releases, localState, enabled, config.manualChannels, config.blockedChannels);
  await fs.writeFile(path.join(root, 'plan.json'), JSON.stringify(result, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT,
    `matrix=${JSON.stringify({ include: result.include })}\nhas_updates=${result.include.length > 0}\n`);
  await summary(`Latest stable release: ${stableReleases(releases)[0]?.tag_name ?? 'none'}.\n\n` +
    result.status.map(line => `- ${line}`).join('\n') + '\n' +
    result.include.map(({ channel, tag }) => `- Ready: ${channel} → ${tag}`).join('\n'));
}

async function generated(channel, release) {
  const hashes = {};
  if (channel === 'aur') for (const name of ['LICENSE-MIT', 'LICENSE-APACHE']) {
    const license = await readApi.file(upstream, name, release.tag_name);
    hashes[name] = createHash('sha256').update(license.text).digest('hex');
  }
  return render(channel, release, hashes);
}

async function writeArtifacts(channel, files) {
  const destination = path.join(root, 'artifacts', channel);
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(destination, name);
    if (!file.startsWith(destination + path.sep)) throw new Error('Artifact path escapes output directory');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  return destination;
}

function assertNoDowngrade(currentText, channel, version) {
  const match = channel === 'homebrew' ? /\bversion "(\d+\.\d+\.\d+)"/.exec(currentText)
    : channel === 'scoop' ? [null, JSON.parse(currentText).version]
      : /pkgver="?(\d+\.\d+\.\d+)/.exec(currentText);
  if (!match) throw new Error(`Cannot establish current ${channel} version`);
  if (compareVersions(match[1], version) > 0) throw new Error(`Refusing ${channel} downgrade from ${match[1]} to ${version}`);
}

async function publishGitChannel(api, channel, version, files) {
  const repo = `gary23w/${channel === 'homebrew' ? 'homebrew-torflix' : 'scoop-torflix'}`;
  const metadata = await api.request(`repos/${repo}`);
  const branch = metadata.default_branch;
  const firstPath = Object.keys(files)[0];
  const current = await api.file(repo, firstPath, branch);
  assertNoDowngrade(current.text, channel, version);
  const ref = await api.request(`repos/${repo}/git/ref/heads/${branch}`);
  await api.commitFiles(repo, branch, files, `Update Torflix to ${version}`, ref.object.sha);
  return `https://github.com/${repo}/blob/${branch}/${firstPath}`;
}

async function publishPR(api, channel, version, release, files) {
  const target = channel === 'winget' ? 'microsoft/winget-pkgs' : 'pacstall/pacstall-programs';
  const fork = `gary23w/${target.split('/')[1]}`;
  const metadata = await api.request(`repos/${target}`);
  const base = metadata.default_branch;
  const firstPath = Object.keys(files)[0];
  const published = await api.file(target, firstPath, base, true);
  if (published) {
    if (channel === 'winget') return `https://github.com/${target}/tree/${base}/${path.posix.dirname(firstPath)}`;
    assertNoDowngrade(published.text, channel, version);
    if (published.text === files[firstPath]) return `https://github.com/${target}/blob/${base}/${firstPath}`;
  }
  // Keep the existing Pacstall inclusion request current while it awaits acceptance.
  const initialBranch = 'codex/add-torflix-deb';
  const initial = channel === 'pacstall' && !published
    ? await api.request(`repos/${target}/pulls?state=open&head=${encodeURIComponent(`gary23w:${initialBranch}`)}`) : [];
  const branch = initial.length ? initialBranch : `codex/torflix-${version}`;
  const branchRef = await api.request(`repos/${fork}/git/ref/heads/${branch}`, { missing: true });
  if (channel === 'pacstall' && branchRef) {
    const current = await api.file(fork, firstPath, branch);
    assertNoDowngrade(current.text, channel, version);
  }
  const ref = await api.request(`repos/${target}/git/ref/heads/${base}`);
  await api.commitFiles(fork, branch, files, `Update Torflix to ${version}`, ref.object.sha);
  const open = await api.request(`repos/${target}/pulls?state=open&head=${encodeURIComponent(`gary23w:${branch}`)}`);
  if (open.length) return open[0].html_url;
  // A closed/rejected version is not automatically reopened or resubmitted on each poll.
  const prior = await api.request(`repos/${target}/pulls?state=closed&head=${encodeURIComponent(`gary23w:${branch}`)}`);
  if (prior.length) throw new Error(`${channel} PR was closed; maintainer attention needed: ${prior[0].html_url}`);
  const assets = selectedAssets(channel, release);
  const result = await api.request(`repos/${target}/pulls`, { method: 'POST', body: {
    title: channel === 'winget' ? `New version: GarrettStimpson.Torflix version ${version}` : `upd: torflix-deb ${version}`,
    head: `gary23w:${branch}`, base, maintainer_can_modify: false,
    body: `Updates Torflix to ${version} using the published [upstream release](${homepage}/releases/tag/${release.tag_name}).\n\n` +
      assets.map(asset => `- \`${asset.name}\`: SHA-256 \`${asset.sha256}\``).join('\n') +
      `\n\nGenerated by the upstream maintainer's distribution workflow. ` +
      (channel === 'winget' ? 'Validated with winget validate before submission.' : 'Pacscript syntax checked with bash -n before submission.'),
  } });
  return result.html_url;
}

function publishChocolatey(directory, version) {
  const key = process.env.CHOCOLATEY_API_KEY;
  if (!key) throw new Error('CHOCOLATEY_API_KEY is required');
  execFileSync('choco', ['pack', 'torflix.nuspec', '--outputdirectory', directory, '--limit-output'], { cwd: directory, stdio: 'inherit' });
  // NuGet's duplicate handling makes a retry safe if state recording failed after upload.
  execFileSync('dotnet', ['nuget', 'push', path.join(directory, `torflix.${version}.nupkg`),
    '--source', 'https://push.chocolatey.org/', '--api-key', key, '--timeout', '120', '--skip-duplicate'], { stdio: 'inherit' });
  return `https://community.chocolatey.org/packages/torflix/${version}`;
}

async function publishAur(directory, version) {
  if (!process.env.AUR_SSH_KEY) throw new Error('AUR_SSH_KEY is required');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'torflix-aur-'));
  const key = path.join(temporary, 'identity'), known = path.join(temporary, 'known_hosts');
  try {
    await fs.writeFile(key, process.env.AUR_SSH_KEY + '\n', { mode: 0o600 });
    const hostKey = process.env.AUR_KNOWN_HOSTS || execFileSync('ssh-keyscan', ['-T', '10', '-t', 'ed25519', 'aur.archlinux.org'], {
      encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    await fs.writeFile(known, hostKey + '\n', { mode: 0o600 });
    const fingerprint = execFileSync('ssh-keygen', ['-lf', known, '-E', 'sha256'], { encoding: 'utf8' }).trim().split(/\s+/)[1];
    // Verified against the fingerprints published at https://aur.archlinux.org/ on 2026-10-27.
    if (fingerprint !== 'SHA256:RFzBCUItH9LZS0cKB5UE6ceAYhBD5C8GeOBip8Z11+4') throw new Error('AUR host key does not match the pinned official fingerprint');
    // AUR publication runs on Linux. Quote the generated paths, never release-supplied data.
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const env = { ...process.env, GIT_SSH_COMMAND: `ssh -i ${quote(key)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${quote(known)}` };
    const checkout = path.join(temporary, 'checkout');
    const git = args => execFileSync('git', args, { cwd: checkout, env, encoding: 'utf8' });
    execFileSync('git', ['clone', 'ssh://aur@aur.archlinux.org/torflix-bin.git', checkout], { env, stdio: 'inherit' });
    const current = await fs.readFile(path.join(checkout, 'PKGBUILD'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (current) assertNoDowngrade(current, 'aur', version);
    for (const name of ['PKGBUILD', '.SRCINFO']) await fs.copyFile(path.join(directory, name), path.join(checkout, name));
    git(['config', 'user.name', 'Garrett Stimpson']);
    git(['config', 'user.email', '61893883+gary23w@users.noreply.github.com']);
    git(['add', 'PKGBUILD', '.SRCINFO']);
    if (git(['diff', '--cached', '--name-only']).trim()) {
      git(['commit', '-m', `Update Torflix to ${version}`]);
      git(['push', 'origin', 'HEAD:master']);
    }
    return 'https://aur.archlinux.org/packages/torflix-bin';
  } finally {
    const resolved = path.resolve(temporary), parent = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(parent) || !path.basename(resolved).startsWith('torflix-aur-')) throw new Error('Unsafe temporary cleanup path');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

async function publish() {
  const channel = option('channel'), tag = option('tag');
  if (!channels.includes(channel) || !versionOf(tag)) throw new Error('Provide a known --channel and stable --tag');
  if (config.manualChannels.includes(channel)) throw new Error(`${channel} is handled manually by request`);
  if (config.blockedChannels[channel]) throw new Error(config.blockedChannels[channel]);
  const stateApi = new GitHub(process.env.GITHUB_STATE_TOKEN);
  const snapshot = await stateApi.file(stateRepo, 'state.json', 'main');
  const state = JSON.parse(snapshot.text), version = versionOf(tag);
  if (compareVersions(version, state[channel]?.version ?? '0.0.0') <= 0) return summary(`${channel}: ${tag} already handled`);
  const release = await readApi.request(`repos/${upstream}/releases/tags/${encodeURIComponent(tag)}`);
  const files = await generated(channel, release), directory = await writeArtifacts(channel, files);
  if (channel === 'winget') execFileSync('winget', ['validate', '--manifest', path.join(directory, `manifests/g/GarrettStimpson/Torflix/${version}`)], { stdio: 'inherit' });
  if (channel === 'pacstall') execFileSync('bash', ['-n', path.join(directory, 'packages/torflix-deb/torflix-deb.pacscript')], { stdio: 'inherit' });
  let url;
  if (['homebrew', 'scoop', 'winget', 'pacstall'].includes(channel)) {
    const api = new GitHub(process.env.GH_PUBLISH_TOKEN);
    url = ['homebrew', 'scoop'].includes(channel)
      ? await publishGitChannel(api, channel, version, files)
      : await publishPR(api, channel, version, release, files);
  } else url = channel === 'chocolatey' ? publishChocolatey(directory, version) : await publishAur(directory, version);
  state[channel] = { version, release: release.id, updated: new Date().toISOString(), url };
  await stateApi.request(`repos/${stateRepo}/contents/state.json`, { method: 'PUT', body: {
    branch: 'main', sha: snapshot.sha, message: `Record ${channel} ${version}`,
    content: Buffer.from(JSON.stringify(state, null, 2) + '\n').toString('base64'),
  } });
  await summary(`${channel} ${tag}: ${url}`);
}

if (command === 'plan') await plan();
else if (command === 'publish') await publish();
else if (command === 'preview') {
  const tag = option('tag'), channel = option('channel');
  if (!versionOf(tag) || !channels.includes(channel)) throw new Error('Provide --channel and --tag');
  const release = await readApi.request(`repos/${upstream}/releases/tags/${encodeURIComponent(tag)}`);
  console.log(await writeArtifacts(channel, await generated(channel, release)));
} else throw new Error('Use plan, preview or publish');
