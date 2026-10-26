//! Puts the default theme where `rust-embed` will find it.
//!
//! The theme is built from `web-site/` (the public status page, a Vite
//! project beside `web-admin/`), which `scripts/theme.sh` syncs into
//! `target/theme/` (running `npm run build` when the source changed). Running
//! it here lets a plain `cargo build` proceed without a setup step and
//! without any download.

use std::process::Command;

fn main() {
    // Cargo reruns this only when one of these changes. The stamp is listed as
    // well, so deleting `target/theme` triggers a resync rather than a later
    // failure inside rust-embed. Watching web-site/ makes any edit there
    // invalidate the sync (node_modules/ and dist/ live under it, but
    // theme.sh hashes around them, so a rebuild that changes nothing relevant
    // stays a no-op).
    println!("cargo:rerun-if-changed=web-site");
    println!("cargo:rerun-if-changed=target/theme/.pin");
    println!("cargo:rerun-if-changed=scripts/theme.sh");

    match Command::new("sh").arg("scripts/theme.sh").status() {
        Ok(status) if status.success() => {}
        Ok(status) => panic!("scripts/theme.sh failed ({status}); see the message above"),
        Err(e) => panic!("could not run scripts/theme.sh: {e}"),
    }
}
