#!/bin/sh
set -eu
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo run --locked -- check --config examples/organization.json
