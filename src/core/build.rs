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
    let install = cmake::Config::new(source)
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
    let target = env::var("TARGET").unwrap();
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
