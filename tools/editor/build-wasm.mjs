import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sdk = process.env.EMSDK || join(root, "target/emsdk");
const env = { ...process.env };
if (process.platform !== "win32" && existsSync(join(sdk, "emsdk_env.sh"))) {
  const activated = spawnSync("bash", ["-c", 'source "$1/emsdk_env.sh" >/dev/null && env -0', "emsdk", sdk], {
    encoding: "utf8",
    env: { ...env, EMSDK_QUIET: "1" },
  });
  if (activated.status !== 0)
    throw new Error(activated.stderr || "Activate the Emscripten SDK before building.");
  for (const item of activated.stdout.split("\0").filter(Boolean)) {
    const split = item.indexOf("=");
    const name = item.slice(0, split);
    if (name === "PATH" || name.startsWith("EM") || name === "SSL_CERT_FILE")
      env[name] = item.slice(split + 1);
  }
}
if (existsSync(join(sdk, "upstream", "emscripten"))) {
  env.PATH = [join(sdk, "upstream", "emscripten"), sdk, env.PATH].join(delimiter);
  env.EMSDK = sdk;
  env.EM_CONFIG ??= join(sdk, ".emscripten");
}
function run(program, args) {
  const result = spawnSync(program, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const target = "wasm32-unknown-emscripten";
run("cargo", ["build", "--locked", "--release", "--target", target, "-p", "pamatcad-wasm"]);
const output = join(root, "apps/editor/public/wasm");
mkdirSync(output, { recursive: true });
const artifacts = resolve(root, env.CARGO_TARGET_DIR || "target", target, "release");
const linker = process.platform === "win32" ? env.EMSDK_PYTHON || "python" : "em++";
const driver = process.platform === "win32" ? [join(sdk, "upstream/emscripten/em++.py")] : [];
run(linker, [
  ...driver,
  join(artifacts, "libpamatcad_wasm.a"),
  "-o",
  join(output, "pamatcad.mjs"),
  "--no-entry",
  "-O2",
  "-fexceptions",
  "-sMODULARIZE",
  "-sEXPORT_ES6",
  "-sENVIRONMENT=worker,node",
  "-sALLOW_MEMORY_GROWTH",
  "-sSTACK_SIZE=4194304",
  "-sEXPORTED_FUNCTIONS=_pamatcad_execute,_pamatcad_release,_free,_malloc",
  "-sEXPORTED_RUNTIME_METHODS=UTF8ToString,stringToNewUTF8",
]);
