use std::{env, process::Command};

fn main() {
    let commit = env::var("PREPERP_BUILD_COMMIT").ok().filter(|value| is_commit(value)).or_else(|| {
        Command::new("git")
            .args(["-C", "../..", "rev-parse", "HEAD"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|value| value.trim().to_lowercase())
            .filter(|value| is_commit(value))
    }).unwrap_or_else(|| "0000000000000000000000000000000000000000".to_string());

    println!("cargo:rustc-env=PREPERP_BUILD_COMMIT={commit}");
    println!("cargo:rerun-if-env-changed=PREPERP_BUILD_COMMIT");
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    tauri_build::build();
}

fn is_commit(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
