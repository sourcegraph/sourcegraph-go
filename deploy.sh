#!/usr/bin/env bash

set -ex
cd "$(dirname "${BASH_SOURCE[0]}")"

# Install dependencies
yarn

# Build & publish extension
src ext publish
