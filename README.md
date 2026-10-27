# Torflix distribution automation

Package-manager publishing lives here, outside the Torflix application repository.

The **Update package managers** workflow checks public stable Torflix releases every five
minutes. GitHub may delay scheduled runs. A workflow dispatch or `torflix-release`
repository dispatch can also run the same check immediately.

Each channel advances independently when all its required desktop artifacts have finished
uploading and GitHub provides their SHA-256 digests. Android-only releases leave desktop
packages alone; desktop files attached later are detected on a subsequent check. Drafts,
prereleases and nonstandard version tags are ignored. Channels never intentionally downgrade.

| Channel | Action | Credential |
| --- | --- | --- |
| Homebrew | Commit updated cask to `gary23w/homebrew-torflix` | `GH_PUBLISH_TOKEN` |
| Scoop | Commit updated manifest to `gary23w/scoop-torflix` | `GH_PUBLISH_TOKEN` |
| winget | Validate manifests and open a version PR | `GH_PUBLISH_TOKEN` |
| Pacstall | Update pending inclusion PR, or open a version PR | `GH_PUBLISH_TOKEN` |
| Chocolatey | Manual publishing, at Gary's request | None required by the automation |
| AUR | Create/update `torflix-bin` through SSH after account registration | `AUR_SSH_KEY` |

The GitHub publishing token must be a user token allowed to write the four public channel
repositories/forks and open PRs against the public upstream repositories. A classic token
with `public_repo` is sufficient. Keep it in GitHub Actions secrets. An existing broader
GitHub CLI token can also work; a dedicated token is preferable for independent revocation.
The workflow's ordinary GITHUB_TOKEN only reads public releases and records its own state,
including a monthly activity commit to keep scheduled checks enabled.

`config.json` explicitly keeps Chocolatey out of automatic publishing, even if a key is
later added. Preview still renders its package for manual submission. Re-enabling automatic
Chocolatey publishing would require a configuration change and CHOCOLATEY_API_KEY.

Missing publishing credentials disable only the affected channels and are shown in the
workflow summary. AUR needs a publisher account with `keys/aur-publishing.pub` registered.
The workflow pins the AUR server's Ed25519 fingerprint, verified against its official home
page, and never disables SSH host verification. AUR_KNOWN_HOSTS is an optional host-key
override which must still match that pinned fingerprint.

AUR registration was temporarily closed when setup was attempted on 2026-10-27. Its dedicated
publishing key is prepared, and `config.json` blocks publication until an account is available.
Once registered, add `keys/aur-publishing.pub` to the account and remove that configuration
block. The next check will create the package from the latest complete release.

`state.json` starts at the already submitted 0.3.0 release. Successful updates record the
version and result URL; unsuccessful channels retry independently. Re-running a successful
version is a no-op. A closed upstream PR requires maintainer attention rather than repeated
automatic resubmission. Review/moderation by upstream services remains outside this workflow.
Do not replace previously published release binaries; issue a new version instead.

Run `npm test` to check selection, integrity rules and all manifest formats. To render a
published version without making any external changes:

```sh
node update.mjs preview --channel=homebrew --tag=v0.3.0
```

Set GH_TOKEN to a GitHub read token for local commands. Generated files appear in ignored
`artifacts/`. `node update.mjs plan` is also read-only; enable channel planning with
GITHUB_PUBLISH_CONFIGURED=true, CHOCOLATEY_CONFIGURED=true and AUR_CONFIGURED=true as appropriate.

The external checker uses scheduled polling to honor the application repository's rule
against committing distribution workflows. No main-repository workflow or README edit is
required. A monthly state commit keeps the public repository active between releases.
