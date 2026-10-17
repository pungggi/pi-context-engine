# Publishing pi-context-engine

Releases are tag-driven through GitHub Actions. Never `npm publish` from a
laptop: `prepublishOnly` blocks it on purpose so provenance and version sync
stay guaranteed.

## Release recipe

```bash
cd ~/source/pi/packages/pi-context-engine

# 1. feature branch with green checks
git checkout -b feat/<short>
npm run check && npm run smoke:env

# 2. bump the version (must equal the tag later)
#    edit package.json → "version": "X.Y.Z"
git add -A && git commit -m "release: X.Y.Z"
git push -u origin feat/<short>
gh pr create --base main --fill
gh pr merge --squash

# 3. tag the merged main commit
git checkout main && git pull --ff-only
git tag vX.Y.Z
git push origin vX.Y.Z

# 4. watch the publish
gh run watch
npm view pi-context-engine version    # expect X.Y.Z

# 5. refresh the local install
pi update npm:pi-context-engine
```

The tag and `package.json` must match — `release.yml` fails the run otherwise.

## Auth

Preferred: **npm Trusted Publishing (OIDC)**. Configure once on npmjs.com:

| field | value |
|---|---|
| Organization or user | `pungggi` |
| Repository | `pi-context-engine` |
| Workflow filename | `release.yml` |
| Environment | *(empty)* |

No `NPM_TOKEN` secret is needed while OIDC works. A Classic **Automation** token
in `secrets.NPM_TOKEN` exists only as a fallback; Granular/Publish tokens fail
with `EOTP` in CI.

> **First-publish bootstrap:** npm cannot attach a Trusted Publisher to a package
> that does not exist yet. For the very first publish only, drop the
> `prepublishOnly` guard, `npm publish --access public` without `--provenance`,
> configure the Trusted Publisher on npmjs.com, then restore the guard. Already
> done — this package is on npm.

## Failed release

```bash
# fix the workflow on the default branch, then either:
gh run rerun <run-id> --failed        # tag commit already contains the fix
# or, only if the version never reached npm:
git tag -f vX.Y.Z && git push origin vX.Y.Z --force
```

Never retag a version that already landed on npm. Bump instead.
