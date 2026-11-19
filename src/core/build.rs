use std::{env, path::PathBuf};

fn main() {
    let source = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../native/occt");
    println!("cargo:rerun-if-changed={}", source.display());
    // Cargo assigns different OUT_DIR hashes to build/check. Share native artifacts
    // within the target/profile so static checks do not rebuild the CAD kernel.
    let cargo_output = PathBuf::from(env::var("OUT_DIR").unwrap());
    let native_output = cargo_output
        .ancestors()
        .nth(3)
        .unwrap()
        .join("pamatcad-native");
    // Separate desktop and CLI Cargo workspaces may share a same-target OCCT build.
    println!("cargo:rerun-if-env-changed=PAMATCAD_NATIVE_DIR");
    let target = env::var("TARGET").unwrap();
    let native_output = if target == env::var("HOST").unwrap() {
        env::var_os("PAMATCAD_NATIVE_DIR")
            .map(PathBuf::from)
            .unwrap_or(native_output)
    } else {
        native_output
    };
    let mut config = cmake::Config::new(source);
    for (env_name, setting) in [
        ("PAMATCAD_OCCT_SOURCE", "FETCHCONTENT_SOURCE_DIR_OCCT"),
        ("PAMATCAD_BUILD_JOBS", "PAMATCAD_BUILD_JOBS"),
    ] {
        println!("cargo:rerun-if-env-changed={env_name}");
        if let Ok(value) = env::var(env_name) {
            config.define(setting, value);
        }
    }
    let install = config
        .out_dir(native_output)
        .profile("Release")
        .define("CMAKE_POSITION_INDEPENDENT_CODE", "ON")
        .build();
    println!("cargo:rustc-link-search=native={}/lib", install.display());
    for library in [
        "pamatcad_occt",
        "TKDESTEP",
        "TKDE",
        "TKXCAF",
        "TKXSBase",
        "TKVCAF",
        "TKCAF",
        "TKV3d",
        "TKOffset",
        "TKFillet",
        "TKBool",
        "TKBO",
        "TKHLR",
        "TKLCAF",
        "TKMesh",
        "TKService",
        "TKCDF",
        "TKShHealing",
        "TKPrim",
        "TKTopAlgo",
        "TKGeomAlgo",
        "TKBRep",
        "TKGeomBase",
        "TKG3d",
        "TKG2d",
        "TKMath",
        "TKernel",
    ] {
        println!("cargo:rustc-link-lib=static={library}");
    }
    if target.contains("apple") {
        println!("cargo:rustc-link-lib=c++");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=IOKit");
    } else if target.contains("linux") {
        println!("cargo:rustc-link-lib=stdc++");
    } else if target.contains("windows") {
        for library in ["user32", "advapi32", "psapi", "gdi32", "winmm", "wsock32"] {
            println!("cargo:rustc-link-lib={library}");
        }
    }
}
