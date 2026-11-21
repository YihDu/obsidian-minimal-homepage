#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
/usr/bin/swiftc -O -parse-as-library -framework EventKit -framework CoreGraphics \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PWD/Info.plist" \
  AppleReader.swift -o "$build_dir/apple-reader"
/usr/bin/codesign --force --sign - --identifier local.minimal-homepage.apple-reader "$build_dir/apple-reader"
/usr/bin/codesign --verify --strict "$build_dir/apple-reader"
/bin/mv -f "$build_dir/apple-reader" apple-reader
