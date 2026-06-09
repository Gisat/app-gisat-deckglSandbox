# Plan: Add CI/CD Workflows (PR Checks + Semantic Release + GHCR)

## Context

`app-gisat-deckglSandbox` is a Vite 5 + React 18 static SPA with a Python backend (Flask + gunicorn) in a two-stage Dockerfile. It currently has a single `deploy.yml` pushing to GitHub Pages — no PR validation, no semantic versioning, no container registry publishing. The default branch (`main`) is protected.

The closest documented profile is **"Next.js 16 + React 19 + TypeScript SPA Projects"** (`e450663d`), adapted for Vite + JS.

## Changes

### 1. Remove GitHub Pages deployment (`deploy.yml`)
- Delete `.github/workflows/deploy.yml` — replaced by GHCR publishing

### 2. Create PR Checks workflow (`pr-checks.yml`)
- `lint` job: ESLint (existing `.eslintrc.cjs`, ESLint 8)
- `docker-build` job: smoke build via `docker/build-push-action@v7`
- No `test` job: no test script defined; add `--passWithNoTests` stub if needed later
- No `format-check` job: no Prettier configured
- `concurrency` group with `cancel-in-progress: true`
- `permissions: contents: read, actions: write`

### 3. Create Release workflow (`release.yml`)
- Trigger: push to `main` + `workflow_dispatch` (manual recovery)
- `npm ci` + `npm run build` before semantic-release
- `npx --package` approach with all `.releaserc.json` plugins explicitly listed
- SSH checkout (`DEPLOY_KEY`) for tag/commit push
- `.release-version` file output via `@semantic-release/exec`
- Login to GHCR → `docker manifest inspect` → conditional build/push
- `docker/metadata-action@v6` with semver + latest tags (gated by `enable=`)
- `docker/build-push-action@v7` with GHA cache
- `concurrency` group with `cancel-in-progress: true`

### 4. Create semantic-release config (`.releaserc.json`)
- Branch: `main`, tag prefix: `v`
- Plugins: commit-analyzer, release-notes-generator, changelog, npm, git, exec, github
- `@semantic-release/exec` writes `.release-version`
- `@semantic-release/git` commits with `[skip ci]`
- Conventional commits preset

### 5. Update `.dockerignore`
- Add `.release-version`, `.releaserc.json`, `.github/` to prevent cache invalidation from CI-only changes

## Files Modified

| File | Change |
|------|--------|
| `.github/workflows/deploy.yml` | **Delete** — replaced by GHCR release |
| `.github/workflows/pr-checks.yml` | **Create** — lint + docker-build on PRs |
| `.github/workflows/release.yml` | **Create** — semantic-release + GHCR push |
| `.releaserc.json` | **Create** — semantic-release configuration |
| `.dockerignore` | **Update** — add `.release-version`, `.releaserc.json` |

## Verification

1. `.github/workflows/pr-checks.yml` — validates on PR to `main`: lint passes, Docker smoke build succeeds
2. `.github/workflows/release.yml` — on push to `main`: semantic-release creates version + tag, Docker image pushed to `ghcr.io/Gisat/app-gisat-deckglSandbox:vX.Y.Z`
3. `workflow_dispatch` — manually re-run release; detects existing tag, skips semantic-release, rebuilds missing image
4. Conventional commits (`feat:`, `fix:`) drive version bumps
