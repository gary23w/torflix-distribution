import test from 'node:test';
import assert from 'node:assert/strict';
import { channels, homepage, versionOf, compareVersions, stableReleases, selectedAssets, makePlan, render } from '../lib/releases.mjs';

const hash = 'abcdef0123456789'.repeat(4);
const otherHash = '0123456789abcdef'.repeat(4);
function release(version = '0.4.0', names) {
  names ??= [
    `Torflix-${version}-mac-arm64.dmg`, `Torflix-${version}-mac-x64.dmg`,
    `Torflix-${version}-win.zip`, `Torflix-${version}-win-arm64.zip`,
    `Torflix-Setup-${version}.exe`, `Torflix-Setup-${version}-arm64.exe`,
    `Torflix-${version}-linux-amd64.deb`, `Torflix-${version}-linux-arm64.deb`,
  ];
  return { id: 42, tag_name: `v${version}`, published_at: '2026-10-27T13:00:00Z', draft: false, prerelease: false,
    assets: names.map((name, i) => ({ name, size: 1234, state: 'uploaded', digest: `sha256:${i % 2 ? otherHash : hash}`,
      browser_download_url: `${homepage}/releases/download/v${version}/${name}` })) };
}
const state = Object.fromEntries(channels.map(c => [c, { version: '0.3.0' }]));
const enabled = Object.fromEntries(channels.map(c => [c, true]));

test('only exact stable numeric tags can become versions or paths', () => {
  assert.equal(versionOf('v1.2.3'), '1.2.3');
  for (const tag of ['v01.2.3', 'v1.2.3-beta', '1.2.3', 'v1.2.3\n', 'v1.2.3/../../x', 'v1.2.3;echo secret']) assert.equal(versionOf(tag), null);
});
test('version comparisons are numeric and do not lose precision', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('999999999999999999999.0.0', '999999999999999999998.0.0'), 1);
  assert.equal(compareVersions('0.3.0', '0.3.0'), 0);
});
test('drafts and prereleases cannot be selected, even with stable-looking tags', () => {
  assert.deepEqual(stableReleases([{ ...release(), draft: true }, { ...release(), prerelease: true }]), []);
});
test('an Android-only release leaves desktop channel versions untouched', () => {
  const result = makePlan([release('0.3.1', ['torflix-0.3.1-arm64-v8a.apk'])], state, enabled);
  assert.equal(result.include.length, 0);
  assert.equal(result.status.length, channels.length);
});
test('assets added after publication are picked up on the next check', () => {
  const snapshot = release('0.3.1', []);
  assert.equal(makePlan([snapshot], state, enabled).include.length, 0);
  snapshot.assets = release('0.3.1').assets;
  assert.equal(makePlan([snapshot], state, enabled).include.length, channels.length);
});
test('independent channel readiness allows an installer without DMGs or Linux packages', () => {
  const result = makePlan([release('0.3.1', ['Torflix-Setup-0.3.1.exe'])], state, enabled);
  assert.deepEqual(result.include.map(i => i.channel), ['chocolatey']);
});
test('a newer incomplete release does not hide a complete earlier unprocessed version', () => {
  const result = makePlan([release('0.5.0', []), release('0.4.0')], state, enabled);
  assert.ok(result.include.every(i => i.tag === 'v0.4.0'));
  assert.equal(result.include.length, channels.length);
});
test('already submitted versions, older releases, and disabled credentials are skipped', () => {
  assert.equal(makePlan([release('0.3.0'), release('0.2.0')], state, enabled).include.length, 0);
  assert.equal(makePlan([release()], state, {}).include.length, 0);
});
test('newer versions are selected semantically rather than by list order', () => {
  const result = makePlan([release('0.9.0'), release('0.10.0')], state, enabled);
  assert.ok(result.include.every(i => i.tag === 'v0.10.0'));
});
test('foreign URLs, incomplete assets and missing checksums cannot enter manifests', () => {
  for (const patch of [{ browser_download_url: 'https://example.com/installer.exe' }, { digest: null }, { state: 'new' }, { size: 0 }]) {
    const fixture = release();
    fixture.assets[4] = { ...fixture.assets[4], ...patch };
    assert.throws(() => selectedAssets('chocolatey', fixture));
    assert.throws(() => render('chocolatey', fixture));
  }
});
test('Scoop can change portable ZIP naming without retaining an obsolete auto-update URL', () => {
  const fixture = release('0.4.0', ['Torflix-0.4.0-win-x64.zip', 'Torflix-0.4.0-win-arm64.zip']);
  const manifest = JSON.parse(render('scoop', fixture)['bucket/torflix.json']);
  assert.equal(manifest.version, '0.4.0');
  assert.equal(manifest.architecture['64bit'].hash, hash);
  assert.ok(manifest.autoupdate.architecture['64bit'].url.endsWith('/Torflix-$version-win-x64.zip'));
  assert.equal(manifest.architecture.arm64.hash, otherHash);
});
test('Homebrew preserves platform requirements and uses distinct architecture digests', () => {
  const cask = render('homebrew', release())['Casks/torflix.rb'];
  assert.ok(cask.includes('version "0.4.0"'));
  assert.ok(cask.includes(`sha256 arm:   "${hash}"`));
  assert.ok(cask.includes(`intel: "${otherHash}"`));
  assert.ok(cask.includes('depends_on macos: :ventura'));
});
test('winget manifests agree on the new version and use the actual publication date', () => {
  const files = render('winget', release());
  assert.equal(Object.keys(files).length, 3);
  for (const [name, text] of Object.entries(files)) {
    assert.ok(name.includes('/0.4.0/'));
    assert.ok(text.includes('PackageVersion: "0.4.0"'));
    assert.ok(!text.includes('0.3.0'));
  }
  const installer = Object.entries(files).find(([name]) => name.endsWith('.installer.yaml'))[1];
  assert.ok(installer.includes('ReleaseDate: 2026-10-27'));
  assert.ok(installer.includes(hash.toUpperCase()));
  assert.ok(installer.includes(otherHash.toUpperCase()));
});
test('Chocolatey package metadata and checksum target the same release', () => {
  const files = render('chocolatey', release());
  assert.ok(files['torflix.nuspec'].includes('<version>0.4.0</version>'));
  assert.ok(files['tools/chocolateyinstall.ps1'].includes('Torflix-Setup-0.4.0.exe'));
  assert.ok(files['tools/chocolateyinstall.ps1'].includes(hash));
});
test('Pacstall keeps the versioned URL variable and updates its hash', () => {
  const script = Object.values(render('pacstall', release()))[0];
  assert.ok(script.includes('pkgver="0.4.0"'));
  assert.ok(script.includes('v${pkgver}/Torflix-${pkgver}-linux-amd64.deb'));
  assert.ok(script.includes(hash));
});
test('AUR metadata matches both binaries and licenses from the new tag', () => {
  const licenseHashes = { 'LICENSE-MIT': '1'.repeat(64), 'LICENSE-APACHE': '2'.repeat(64) };
  const files = render('aur', release(), licenseHashes);
  for (const text of Object.values(files)) {
    for (const digest of [hash, otherHash, ...Object.values(licenseHashes)]) assert.ok(text.includes(digest));
    assert.ok(!text.includes('0.3.0'));
  }
  assert.throws(() => render('aur', release(), {}));
});
