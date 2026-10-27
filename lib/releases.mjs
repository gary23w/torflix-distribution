import { readFileSync } from 'node:fs';

export const upstream = 'gary23w/torflix';
export const homepage = `https://github.com/${upstream}`;
export const channels = ['homebrew', 'scoop', 'winget', 'pacstall', 'chocolatey', 'aur'];
export const templates = Object.fromEntries([
  'homebrew.rb', 'scoop.json', 'chocolatey.nuspec', 'chocolateyinstall.ps1',
  'PKGBUILD', 'SRCINFO', 'torflix-deb.pacscript', 'winget.yaml',
  'winget.locale.en-US.yaml', 'winget.installer.yaml',
].map(name => [name, readFileSync(new URL(`../templates/${name}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n')]));

export function versionOf(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag ?? '');
  return match ? match.slice(1).join('.') : null;
}

export function compareVersions(a, b) {
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

export function stableReleases(releases) {
  return releases.filter(r => !r.draft && !r.prerelease && versionOf(r.tag_name) && r.published_at)
    .sort((a, b) => compareVersions(versionOf(b.tag_name), versionOf(a.tag_name)));
}

// Each group is required; alternatives within a group accommodate the original Windows ZIP name.
export function requiredAssets(channel, version) {
  switch (channel) {
    case 'homebrew': return [[`Torflix-${version}-mac-arm64.dmg`], [`Torflix-${version}-mac-x64.dmg`]];
    case 'scoop': return [[`Torflix-${version}-win.zip`, `Torflix-${version}-win-x64.zip`], [`Torflix-${version}-win-arm64.zip`]];
    case 'winget': return [[`Torflix-Setup-${version}.exe`], [`Torflix-Setup-${version}-arm64.exe`]];
    case 'chocolatey': return [[`Torflix-Setup-${version}.exe`]];
    case 'pacstall': return [[`Torflix-${version}-linux-amd64.deb`]];
    case 'aur': return [[`Torflix-${version}-linux-amd64.deb`], [`Torflix-${version}-linux-arm64.deb`]];
    default: throw new Error(`Unknown channel: ${channel}`);
  }
}

export function selectedAssets(channel, release) {
  const version = versionOf(release.tag_name);
  if (!version || release.draft || release.prerelease || !release.published_at) throw new Error('A published stable release is required');
  return requiredAssets(channel, version).map(names => {
    const asset = names.map(name => release.assets.find(a => a.name === name)).find(Boolean);
    if (!asset) throw new Error(`Waiting for ${names.join(' or ')}`);
    if (asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size < 1 || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) {
      throw new Error(`Missing upload completion, size or SHA-256: ${asset.name}`);
    }
    const expected = `${homepage}/releases/download/${release.tag_name}/${asset.name}`;
    if (asset.browser_download_url !== expected) throw new Error(`Unexpected download origin: ${asset.name}`);
    return { name: asset.name, url: expected, sha256: asset.digest.slice(7) };
  });
}

export function makePlan(releases, state, enabled) {
  const stable = stableReleases(releases), include = [], status = [];
  for (const channel of channels) {
    if (!enabled[channel]) { status.push(`${channel}: needs publishing credentials`); continue; }
    const newer = stable.filter(r => compareVersions(versionOf(r.tag_name), state[channel]?.version ?? '0.0.0') > 0);
    let found;
    for (const release of newer) {
      try { selectedAssets(channel, release); found = release; break; }
      catch (error) { status.push(`${channel} ${release.tag_name}: ${error.message}`); }
    }
    if (found) include.push({ channel, tag: found.tag_name, os: ['winget', 'chocolatey'].includes(channel) ? 'windows-2025' : 'ubuntu-24.04' });
    else if (!newer.length) status.push(`${channel}: current at ${state[channel]?.version ?? '0.0.0'}`);
  }
  return { include, status };
}

export function render(channel, release, licenseHashes = {}) {
  const v = versionOf(release.tag_name), assets = selectedAssets(channel, release);
  const base = name => templates[name].replaceAll('0.3.0', v);
  const [first, second] = assets;
  switch (channel) {
    case 'homebrew': return { 'Casks/torflix.rb': base('homebrew.rb')
      .replace(/sha256 arm:\s*"[a-f0-9]+",\s*intel:\s*"[a-f0-9]+"/, `sha256 arm:   "${first.sha256}",\n         intel: "${second.sha256}"`) };
    case 'scoop': {
      const manifest = JSON.parse(base('scoop.json'));
      for (const [arch, asset] of [['64bit', first], ['arm64', second]]) {
        manifest.architecture[arch] = { url: asset.url, hash: asset.sha256 };
        manifest.autoupdate.architecture[arch].url = asset.url.replaceAll(v, '$version');
      }
      return { 'bucket/torflix.json': JSON.stringify(manifest, null, 4) + '\n' };
    }
    case 'winget': {
      const prefix = `manifests/g/GarrettStimpson/Torflix/${v}/GarrettStimpson.Torflix`;
      const installer = base('winget.installer.yaml')
        .replace(/ReleaseDate: .*/, `ReleaseDate: ${release.published_at.slice(0, 10)}`)
        .replace(/Installers:\n[\s\S]*?ManifestType:/, 'Installers:\n' + assets.map((a, i) =>
          `- Architecture: ${i ? 'arm64' : 'x64'}\n  InstallerUrl: ${a.url}\n  InstallerSha256: ${a.sha256.toUpperCase()}\n`).join('') + 'ManifestType:');
      return { [`${prefix}.yaml`]: base('winget.yaml'), [`${prefix}.locale.en-US.yaml`]: base('winget.locale.en-US.yaml'), [`${prefix}.installer.yaml`]: installer };
    }
    case 'chocolatey': return {
      'torflix.nuspec': base('chocolatey.nuspec'),
      'tools/chocolateyinstall.ps1': base('chocolateyinstall.ps1')
        .replace(/url64bit\s*=\s*'[^']*'/, `url64bit       = '${first.url}'`)
        .replace(/checksum64\s*=\s*'[^']*'/, `checksum64     = '${first.sha256}'`),
    };
    case 'pacstall': return { 'packages/torflix-deb/torflix-deb.pacscript': base('torflix-deb.pacscript')
      .replace(/sha256sums=\("[a-f0-9]+"\)/, `sha256sums=("${first.sha256}")`) };
    case 'aur': {
      for (const name of ['LICENSE-MIT', 'LICENSE-APACHE']) if (!/^[a-f0-9]{64}$/.test(licenseHashes[name] ?? '')) throw new Error(`Missing tagged license checksum: ${name}`);
      let build = base('PKGBUILD').replace(/pkgver=.*/, `pkgver=${v}`);
      build = build.replace(/sha256sums=\('[a-f0-9]+'\s*'[a-f0-9]+'\)/,
        `sha256sums=('${licenseHashes['LICENSE-MIT']}'\n            '${licenseHashes['LICENSE-APACHE']}')`);
      for (const [arch, asset] of [['x86_64', first], ['aarch64', second]]) {
        build = build.replace(new RegExp(`sha256sums_${arch}=\\('[a-f0-9]+'\\)`), `sha256sums_${arch}=('${asset.sha256}')`);
      }
      let info = base('SRCINFO'), hashIndex = 0;
      const hashes = [licenseHashes['LICENSE-MIT'], licenseHashes['LICENSE-APACHE']];
      info = info.replace(/\tsha256sums = [a-f0-9]+/g, () => `\tsha256sums = ${hashes[hashIndex++]}`)
        .replace(/\tsha256sums_x86_64 = [a-f0-9]+/, `\tsha256sums_x86_64 = ${first.sha256}`)
        .replace(/\tsha256sums_aarch64 = [a-f0-9]+/, `\tsha256sums_aarch64 = ${second.sha256}`);
      return { PKGBUILD: build, '.SRCINFO': info };
    }
    default: throw new Error(`Unknown channel: ${channel}`);
  }
}
