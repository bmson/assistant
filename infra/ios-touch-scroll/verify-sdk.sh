#!/bin/sh
# Read-only preflight on the eventual runner; never builds or starts a device.
set -eu
platform=${1:-iphonesimulator}
case "$platform" in iphonesimulator|iphoneos) ;; *) echo "Expected iphonesimulator or iphoneos" >&2; exit 2 ;; esac
platform_path=$(xcrun --sdk "$platform" --show-sdk-platform-path)
headers="$platform_path/Developer/Library/Frameworks/XCTest.framework/Headers"
# Require declarations in the selected runner's public SDK, not a version guess.
grep -Eq '@interface XCTHitchMetric : NSObject' "$headers/XCTMetric.h"
grep -Eq '@interface XCTHitchMetric \(UIAutomation\)' "$headers/XCTMetric+UIAutomation.h"
grep -Eq 'initWithApplication:.*XCUIApplication' "$headers/XCTMetric+UIAutomation.h"
grep -Eq 'scrollingAndDecelerationMetric.*ios\(15.0\)' "$headers/XCTMetric.h"
printf 'Selected platform: %s\n' "$platform_path"
xcodebuild -version
grep -En -B 1 '@interface XCTHitchMetric' "$headers/XCTMetric.h" "$headers/XCTMetric+UIAutomation.h"
printf 'Public metric declarations present; runtime still requires iOS 26+.\n'
