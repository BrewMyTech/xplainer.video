#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Download every input of the macOS FFmpeg build into a cache directory and
# verify it: the sha256 pinned in pins.env for all of them, and the detached
# OpenPGP signature for FFmpeg and zlib against the public keys committed in
# keys/, whose primary-key fingerprints are pinned too.
#
#   infra/ffmpeg/fetch.sh <cache-dir>
#
# A file already in the cache with the pinned digest is used as it is, so a
# source bundle downloaded from cdn.xplainer.video works as a cache and the
# build runs offline from it. A file whose digest is wrong is fetched again; if
# the fresh copy is wrong too, nothing is written and the script exits 1.
#
# Each input is tried at its upstream URL first and at the published source
# bundle second (XP_SOURCE_MIRROR, empty to disable), so a vanished upstream
# archive does not strand a pin. The digest is the trust anchor either way.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pins.env
. "$here/pins.env"

cache="${1:?usage: fetch.sh <cache-dir>}"
mirror="${XP_SOURCE_MIRROR-$XP_CDN_BASE/$XP_BUILD_VERSION/source}"
mkdir -p "$cache"

sha256_of() {
  shasum -a 256 "$1" | cut -d' ' -f1
}

try_download() { # url dest
  curl --fail --silent --show-error --location --retry 4 --retry-all-errors \
    --connect-timeout 30 --output "$2" "$1"
}

fetch() { # url sha256
  local url="$1" want="$2"
  local name="${url##*/}"
  local dest="$cache/$name"
  if [ -f "$dest" ] && [ "$(sha256_of "$dest")" = "$want" ]; then
    echo "cached    $name"
    return
  fi
  local candidates=("$url")
  if [ -n "$mirror" ]; then
    candidates+=("$mirror/$name")
  fi
  local candidate got
  for candidate in "${candidates[@]}"; do
    echo "fetching  $candidate"
    rm -f "$dest.part"
    if ! try_download "$candidate" "$dest.part"; then
      continue
    fi
    got="$(sha256_of "$dest.part")"
    if [ "$got" = "$want" ]; then
      mv "$dest.part" "$dest"
      echo "verified  $name sha256 $want"
      return
    fi
    echo "sha256 mismatch for $candidate: pinned $want, got $got" >&2
  done
  rm -f "$dest.part"
  echo "fetch.sh: no source produced $name with sha256 $want" >&2
  exit 1
}

verify_signature() { # file signature key-file primary-fingerprint
  local file="$1" signature="$2" key="$3" fingerprint="$4"
  local home status signer
  home="$(mktemp -d)"
  gpg --homedir "$home" --batch --quiet --import "$key" 2>/dev/null
  # VALIDSIG's last field is the fingerprint of the primary key, whichever
  # subkey made the signature. Only that key is in this keyring, so a match
  # proves the signature is good and made by the pinned key.
  status="$(gpg --homedir "$home" --batch --status-fd 1 --verify "$signature" "$file" 2>/dev/null || true)"
  rm -rf "$home"
  signer="$(printf '%s\n' "$status" | awk '$2 == "VALIDSIG" { print $NF }')"
  if [ "$signer" != "$fingerprint" ]; then
    echo "fetch.sh: ${file##*/} is not signed by $fingerprint (VALIDSIG: ${signer:-none})" >&2
    exit 1
  fi
  echo "signature ${file##*/} good, primary key $fingerprint"
}

fetch "$FFMPEG_URL" "$FFMPEG_SHA256"
fetch "$FFMPEG_ASC_URL" "$FFMPEG_ASC_SHA256"
fetch "$X264_URL" "$X264_SHA256"
fetch "$ZLIB_URL" "$ZLIB_SHA256"
fetch "$ZLIB_ASC_URL" "$ZLIB_ASC_SHA256"
fetch "$NASM_URL" "$NASM_SHA256"

verify_signature "$cache/${FFMPEG_URL##*/}" "$cache/${FFMPEG_ASC_URL##*/}" \
  "$here/keys/ffmpeg-release.asc" "$FFMPEG_KEY_FPR"
verify_signature "$cache/${ZLIB_URL##*/}" "$cache/${ZLIB_ASC_URL##*/}" \
  "$here/keys/zlib-release.asc" "$ZLIB_KEY_FPR"
