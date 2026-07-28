#!/usr/bin/env bash
#
# Cut a new release of @flashmandu/app-bridge.
#
#   bin/release.sh 0.1.0
#
# Bumps package.json, commits, tags the HEAD as vX.Y.Z, and pushes branch +
# tag. The Release GitHub Action then runs the build, publishes to npm, and
# creates the GitHub release.
#
# Mirrors flashmandu-app-cli's bin/release.sh (tag-driven): the version source
# of truth is package.json, bumped in the same commit as the tag.
set -euo pipefail

VERSION="${1:-}"
if [ -z "${VERSION}" ]; then
  echo "Usage: $0 <version>   e.g. $0 0.1.0" >&2
  exit 1
fi

VERSION="${VERSION#v}"
TAG="v${VERSION}"

if ! [[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Version must be semver (X.Y.Z), got: ${VERSION}" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty — commit or stash changes before releasing." >&2
  exit 1
fi

if git rev-parse "${TAG}" >/dev/null 2>&1; then
  echo "Tag ${TAG} already exists." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

# Bump package.json version in place (no npm install / network needed).
node -e "const p=require('./package.json');p.version='${VERSION}';require('fs').writeFileSync('./package.json', JSON.stringify(p,null,2)+'\n');"

git add package.json
git commit -m "chore(release): ${TAG}" >/dev/null
git tag -a "${TAG}" -m "${TAG}"
git push origin HEAD
git push origin "${TAG}"

echo "Pushed ${TAG}. The Release workflow will build, publish to npm, and open the GitHub release."
