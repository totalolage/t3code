#!/usr/bin/env bash

set -euo pipefail

APP_VARIANT=f8y EXPO_NO_GIT_STATUS=1 expo prebuild --clean --platform android --no-install

cd android
./gradlew :app:assembleRelease
