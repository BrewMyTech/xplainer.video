#!/usr/bin/env bash
# Upload a release directory (assemble.sh) to the R2 bucket behind
# cdn.xplainer.video, then read every object back through the CDN.
#
#   infra/ffmpeg/publish.sh <release-dir>
#
# Needs R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_ACCOUNT_ID; R2_BUCKET
# defaults to xplainer-artifacts (infra/terraform). The token needs Object Read
# as well as Write: the read is the overwrite check below. With
# XP_PUBLISH_DRY_RUN=1 it needs none of them and prints what it would upload.
#
# THE KEYS ARE IMMUTABLE. A published object is served from cache for 30 days
# and pinned by digest in every manifest that names it, so this script never
# replaces one: an object that already exists with the same bytes is skipped,
# and one that exists with different bytes stops the publish. Changing a build
# means a new XP_BUILD_VERSION (pins.env).
#
# Order matters for the same reason: the source bundle first, then the zips,
# and the manifest fragment and SHA256SUMS last, so nothing is ever published
# that names an object not yet there.
#
# The upload is plain S3 over curl's SigV4 support; no AWS CLI, no AWS service.
# Runs on Linux or macOS; needs curl and jq.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pins.env
. "$here/pins.env"

release="${1:?usage: publish.sh <release-dir>}"
dry_run="${XP_PUBLISH_DRY_RUN:-0}"
bucket="${R2_BUCKET:-xplainer-artifacts}"
public_base="$XP_CDN_BASE/$XP_BUILD_VERSION"
key_prefix="${public_base#https://*/}"

if [ ! -f "$release/SHA256SUMS" ] || [ ! -f "$release/source/MANIFEST" ]; then
  echo "publish.sh: $release is not an assembled release directory" >&2
  exit 1
fi
if find "$release/source" -name 'xplainer-ffmpeg-build-*-dirty-*' | grep -q .; then
  echo "publish.sh: the source bundle was made from modified scripts; publish from a commit" >&2
  exit 1
fi
# A published version is complete or it is not published: the fragment and
# SHA256SUMS can never be rewritten, so an arm64-only release would fix this
# version as arm64-only for good.
platforms="$(jq -r '.ffmpeg.expected | keys | sort | join(" ")' "$release/ffmpeg-$XP_BUILD_VERSION.json")"
if [ "$platforms" != "darwin-arm64 darwin-x64" ]; then
  echo "publish.sh: the release names '$platforms'; a publish carries darwin-arm64 and darwin-x64" >&2
  exit 1
fi
if [ "$XP_SCRIPTS_LICENCE" = UNDECIDED ]; then
  echo "publish.sh: XP_SCRIPTS_LICENCE in pins.env is UNDECIDED; the scripts in source/ are part" \
    "of the GPL corresponding source and must carry a licence before they are published" >&2
  exit 1
fi
if [ "$dry_run" != 1 ]; then
  : "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID is not set}"
  : "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is not set}"
  : "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is not set}"
fi
endpoint="https://${R2_ACCOUNT_ID:-ACCOUNT}.r2.cloudflarestorage.com/$bucket"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}
md5_of() {
  if command -v md5sum >/dev/null 2>&1; then
    md5sum "$1" | cut -d' ' -f1
  else
    md5 -q "$1"
  fi
}
content_type() {
  case "$1" in
    *.zip) echo application/zip ;;
    *.json) echo application/json ;;
    *.tar.xz) echo application/x-xz ;;
    *.tar.gz) echo application/gzip ;;
    *.tar.bz2) echo application/x-bzip2 ;;
    *.asc) echo application/pgp-signature ;;
    *) echo "text/plain; charset=utf-8" ;;
  esac
}

# SHA-256 of an empty body, the payload hash of a HEAD.
empty_sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855

s3() { # key [curl arguments...]
  local key="$1"
  shift
  # The credentials go to curl on its standard input, not its argument list,
  # where any process on the runner could read them.
  printf 'user = "%s:%s"\n' "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY" |
    curl --config - --silent --show-error --retry 3 --retry-all-errors \
      --aws-sigv4 "aws:amz:auto:s3" "$@" "$endpoint/$key"
}

# The ETag R2 returns for an object uploaded in one PUT is the MD5 of its bytes.
remote_etag() { # key -> etag without quotes, or empty when absent
  local headers status
  headers="$(s3 "$1" --head --header "x-amz-content-sha256: $empty_sha256" \
    --dump-header - --output /dev/null)"
  # With --retry, every attempt's headers are in $headers; the last block is
  # the answer.
  headers="$(printf '%s\n' "$headers" | tr -d '\r')"
  status="$(printf '%s\n' "$headers" | awk '/^HTTP\// { status = $2 } END { print status }')"
  case "$status" in
    200)
      printf '%s\n' "$headers" |
        awk '/^HTTP\// { etag = "" } tolower($1) == "etag:" { gsub(/"/, "", $2); etag = $2 } END { print etag }'
      ;;
    404) ;;
    *)
      echo "publish.sh: HEAD $1 answered ${status:-nothing}" >&2
      exit 1
      ;;
  esac
}

upload() { # relative path inside the release directory
  local path="$1" file="$release/$1" key="$key_prefix/$1"
  local local_md5 etag code
  if [ "$dry_run" = 1 ]; then
    echo "would put $key ($(content_type "$path"), sha256 $(sha256_of "$file"))"
    return
  fi
  local_md5="$(md5_of "$file")"
  etag="$(remote_etag "$key")"
  if [ "$etag" = "$local_md5" ]; then
    echo "present   $key (same bytes)"
    return
  fi
  if [ -n "$etag" ]; then
    echo "publish.sh: $key already exists with different bytes (etag $etag, local md5 $local_md5);" \
      "published keys are immutable, so bump XP_BUILD_VERSION in pins.env" >&2
    exit 1
  fi
  code="$(s3 "$key" --upload-file "$file" \
    --header "Content-Type: $(content_type "$path")" \
    --header "Cache-Control: public, max-age=31536000, immutable" \
    --header "x-amz-content-sha256: $(sha256_of "$file")" \
    --header "If-None-Match: *" \
    --output /dev/null --write-out '%{http_code}')"
  if [ "$code" != 200 ]; then
    echo "publish.sh: PUT $key answered $code" >&2
    exit 1
  fi
  etag="$(remote_etag "$key")"
  if [ "$etag" != "$local_md5" ]; then
    echo "publish.sh: $key reads back with etag $etag, expected $local_md5" >&2
    exit 1
  fi
  echo "put       $key"
}

# The tarballs, then source/README.txt and source/MANIFEST that name them, then
# the zips, then the fragment and SHA256SUMS that name those.
paths=()
while IFS= read -r path; do paths+=("$path"); done < <(cd "$release" && find source -type f ! -name README.txt ! -name MANIFEST | LC_ALL=C sort)
paths+=(source/README.txt source/MANIFEST)
while IFS= read -r path; do paths+=("$path"); done < <(cd "$release" && find . -maxdepth 1 -name '*.zip' | sed 's#^\./##' | LC_ALL=C sort)
paths+=("ffmpeg-$XP_BUILD_VERSION.json" SHA256SUMS)

for path in "${paths[@]}"; do
  upload "$path"
done

if [ "$dry_run" = 1 ]; then
  exit 0
fi

# Read every object back through the CDN, the way `xplainer setup` will.
scratch="$(mktemp -d)"
for path in "${paths[@]}"; do
  if ! curl --fail --silent --show-error --location --retry 5 --retry-all-errors \
    --output "$scratch/object" "$public_base/$path"; then
    echo "publish.sh: $public_base/$path is not readable through the CDN" >&2
    exit 1
  fi
  if [ "$(sha256_of "$scratch/object")" != "$(sha256_of "$release/$path")" ]; then
    echo "publish.sh: $public_base/$path serves different bytes from what was uploaded" >&2
    exit 1
  fi
  echo "served    $public_base/$path"
done
rm -rf "$scratch"
