#!/usr/bin/env python
"""Place the two Android codegen artifacts the Tauri CLI does not (re)write.

`tauri android init` writes the project skeleton and `tauri android android-studio-script`
(which the gradle RustPlugin runs through npm) writes `tauri.settings.gradle` and
`app/tauri.build.gradle.kts`. Two more artifacts come from the crate templates in
`tauri-<ver>/mobile/` and were NOT written by either, so a clean checkout fails to build:

1. `android-codegen/TauriActivity.kt` -> app's `.../<pkg>/generated/`
   Without it every ABI fails with `Unresolved reference 'TauriActivity'`: the generated
   MainActivity extends `TauriActivity()` with no import because the codegen file lands in the
   SAME package.

2. `proguard-tauri.pro` -> `app/`
   `app/build.gradle.kts` applies every `*.pro` under the app module, and this one carries the
   keep rule for the plugin bridge. Without it the RELEASE build installs and then dies on
   launch with `NoSuchMethodError: ... MainActivity;.getPluginManager()` - R8 stripped the
   method that `app.tauri.plugin.PluginManager` looks up by name.

Both templates carry a placeholder (`{{package}}` / `$PACKAGE`) that must be replaced with the
app's package identifier. Both destination paths are gitignored, so this script is the
reproducible way to recreate them; it is idempotent.

Usage:  python tools/android-codegen.py [--tauri-version 2.12.1]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TAURI_DIR = REPO / "src-tauri"
ANDROID_DIR = TAURI_DIR / "gen" / "android"
CARGO_SRC = Path.home() / ".cargo" / "registry" / "src"


def app_package() -> str:
    """The Android package identifier, from tauri.conf.json."""
    for name in ("tauri.android.conf.json", "tauri.conf.json"):
        path = TAURI_DIR / name
        if not path.is_file():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        identifier = data.get("identifier") or data.get("app", {}).get("identifier")
        if identifier:
            return identifier
    raise SystemExit("could not read the package identifier from src-tauri/tauri*.json")


def crate_dir(tauri_version: str | None) -> Path:
    """Locate the tauri crate's `mobile/` template directory."""
    if not CARGO_SRC.is_dir():
        raise SystemExit(f"no cargo registry sources at {CARGO_SRC}")
    candidates: list[Path] = []
    for index in CARGO_SRC.iterdir():
        if not index.is_dir():
            continue
        for crate in index.glob("tauri-*/mobile"):
            version = crate.parent.name.split("-", 1)[1]
            if tauri_version and version != tauri_version:
                continue
            candidates.append(crate)
    if not candidates:
        raise SystemExit(f"no tauri crate templates found under {CARGO_SRC}")
    # Highest version wins when the registry holds several.
    def key(p: Path) -> tuple:
        return tuple(int(x) if x.isdigit() else 0 for x in re.split(r"[.\-]", p.parent.name.split("-", 1)[1]))

    return sorted(candidates, key=key)[-1]


def substitute(template: Path, destination: Path, placeholder: str, value: str) -> None:
    body = template.read_text(encoding="utf-8").replace(placeholder, value)
    if placeholder in body:
        raise SystemExit(f"{template.name}: placeholder {placeholder!r} left unsubstituted")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and destination.read_text(encoding="utf-8") == body:
        print(f"  up to date: {destination.relative_to(REPO)}")
        return
    destination.write_text(body, encoding="utf-8")
    print(f"  wrote     : {destination.relative_to(REPO)} ({destination.stat().st_size} bytes)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tauri-version", default=None, help="pin the tauri crate version")
    args = parser.parse_args(argv)

    package = app_package()
    mobile = crate_dir(args.tauri_version)
    print(f"package: {package}")
    print(f"templates: {mobile}")

    if not ANDROID_DIR.is_dir():
        raise SystemExit(f"{ANDROID_DIR} does not exist - run `tauri android init` first")

    package_path = Path(*package.split("."))
    substitute(
        mobile / "android-codegen" / "TauriActivity.kt",
        ANDROID_DIR / "app" / "src" / "main" / "java" / package_path / "generated" / "TauriActivity.kt",
        "{{package}}",
        package,
    )
    substitute(
        mobile / "proguard-tauri.pro",
        ANDROID_DIR / "app" / "proguard-tauri.pro",
        "$" + "PACKAGE",
        package,
    )
    print("done - both artifacts are gitignored codegen output")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())