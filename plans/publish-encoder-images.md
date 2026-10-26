# Plan: Publish TiTiler encoder images from the release workflow

## Context

`.github/workflows/release.yml` runs semantic-release on `main`/`workflow_dispatch`
and then builds/pushes exactly **one** image: `ghcr.io/${{ github.repository }}`
(the app image, `context: .`).

The `deploy/titiler-caching` stack has two sibling tile encoders that are only
ever built locally by compose:

- `deploy/titiler-caching/terrarium-encoder/` — Mapzen Terrarium RGB encoder
  (`image: titiler-terrarium-encoder` in `deploy/titiler-caching/docker-compose.yml:47`
  and `deploy/titiler-combined/docker-compose.yml:75`).
- `deploy/titiler-caching/float32-encoder/` — raw float32 encoder
  (`deploy/titiler-caching/docker-compose.yml:78`,
  `deploy/titiler-combined/docker-compose.yml:100`).

Both have standalone `Dockerfile`s (`FROM python:3.12-slim`, self-contained
context `<dir>/` + `<dir>/*.py`). They must be published so deployments can pull
a versioned image instead of building from source.

## Changes

1. Split the existing single `release` job into two jobs:
   - `release` — unchanged semantic-release logic, but exposes the outcome as
     **job outputs** (`new_release_published`, `new_release_version`) instead of
     only step outputs.
   - `docker` — `needs: release`, `if: needs.release.outputs.new_release_published == 'true'`,
     with a `strategy.matrix` over the three images (app + two encoders). Each
     matrix entry supplies:
     - `name` (job label), `context` (build context), `image_suffix`, `cache_scope`.
2. Per matrix leg, keep the existing proven step sequence: GHCR login →
   `docker manifest inspect` existence check (per image) → buildx → metadata
   (semver + `latest`) → `build-push-action` with a per-image GHA cache scope.
3. Move `packages: write` from the `release` job to the new `docker` job (the
   only job that pushes). `release` keeps its existing permissions.
4. Use `github.repository` as the image prefix for all three so nothing is
   hardcoded.

### Image naming (decision)

| Matrix `name` | Build context | Published image |
|---------------|---------------|-----------------|
| `app` | `.` | `ghcr.io/<owner>/<repo>` (unchanged) |
| `terrarium-encoder` | `deploy/titiler-caching/terrarium-encoder` | `ghcr.io/<owner>/<repo>-terrarium-encoder` |
| `float32-encoder` | `deploy/titiler-caching/float32-encoder` | `ghcr.io/<owner>/<repo>-float32-encoder` |

Suffix style (rather than a nested path) keeps every image lowercase, tied to the
repo, and avoid GHCR nested-path package-linking ambiguity. `<owner>/<repo>` is
`gisat/app-gisat-deckglSandbox`.

## Files Modified

| File | Change |
|------|--------|
| `.github/workflows/release.yml` | Split into `release` + matrixed `docker` job; publish app + 2 encoder images |
| `.github/workflows/pr-checks.yml` | `docker-build` job matrixed over the same 3 images (app + 2 encoders); smoke-builds them (`load: true`, no push) |
| `plans/publish-encoder-images.md` | This plan |

## Out of Scope (possible follow-ups)

- Pointing the compose files at the published encoder images (they still build
  from source locally).

## Verification

1. YAML must lint: `docker run --rm -v "$PWD/.github/workflows:/w" mikefarah/yq e '.jobs | keys' /w/release.yml`
   (or `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))"`).
2. `gh workflow view release.yml` / `actionlint` (if available) report no syntax errors.
3. Dry-run reasoning:
   - `new_release_published == 'false'` (no release) → `docker` job skipped entirely.
   - `new_release_published == 'true'` → three matrix legs; each tags the image
     with `vX.Y.Z`, `X.Y`, `X`, and `latest`; re-runs skip an image whose
     `vX.Y.Z` manifest already exists.
4. `ghcr.io/<owner>/<repo>-terrarium-encoder` and `-float32-encoder` appear as
   packages after the next release-triggering merge to `main`.
