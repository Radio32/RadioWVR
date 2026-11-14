#!/bin/sh
# Runs the manager's tests with macOS's built-in JavaScript engine.
cd "$(dirname "$0")/.." || exit 1
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
exec "$JSC" docs/js/audio.js docs/js/model.js docs/js/zip.js test/test.js
