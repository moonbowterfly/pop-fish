"""Build the Pop-Fish XPI.

An XPI is a plain ZIP whose root is the plugin directory. `manifest.json` is
written first so the archive stays friendly to strict add-on readers.

Only runtime files are packaged. This is an allowlist, not a blocklist: a
temporary JSON snapshot, an editor backup, a test fixture or a stray credential
file cannot enter the archive merely because nobody remembered to exclude its
extension.
"""
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent

ROOT_FILES = {"manifest.json", "bootstrap.js", "prefs.js", "LICENSE"}
CHROME_PREFIX = "chrome/content/"
CHROME_SUFFIXES = {".js", ".xhtml", ".css", ".png", ".svg", ".ftl"}
LOCALE_PREFIX = "locale/"
LOCALE_SUFFIXES = {".ftl"}


def is_runtime(rel: Path) -> bool:
    posix = rel.as_posix()
    if posix in ROOT_FILES:
        return True
    if any(part.startswith(".") for part in rel.parts):
        return False
    if posix.startswith(CHROME_PREFIX):
        return rel.suffix.lower() in CHROME_SUFFIXES
    if posix.startswith(LOCALE_PREFIX):
        # locale/<locale>/<file>.ftl — exactly three segments.
        return len(rel.parts) == 3 and rel.suffix.lower() in LOCALE_SUFFIXES
    return False


def collect() -> list[Path]:
    files: list[Path] = []
    for path in sorted(ROOT.rglob("*")):
        if path.is_dir():
            continue
        rel = path.relative_to(ROOT)
        if is_runtime(rel):
            files.append(rel)

    files.sort(key=lambda r: (r.as_posix() != "manifest.json", r.as_posix()))
    return files


def main() -> int:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    plugin_id = manifest["applications"]["zotero"]["id"]

    # Guard against the version constant drifting from the manifest (a real
    # defect the external review found in v0.1.0).
    core = (ROOT / "chrome" / "content" / "scripts" / "popfish.js").read_text(encoding="utf-8")
    match = __import__("re").search(r'const PLUGIN_VERSION = "([^"]+)"', core)
    if not match:
        print("ERROR: PLUGIN_VERSION not found in popfish.js", file=sys.stderr)
        return 1
    if match.group(1) != version:
        print(
            f"ERROR: version mismatch — manifest.json={version} popfish.js={match.group(1)}",
            file=sys.stderr,
        )
        return 1

    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    target = dist / f"pop-fish-{version}.xpi"
    if target.exists():
        target.unlink()

    files = collect()
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for rel in files:
            archive.write(ROOT / rel, rel.as_posix())

    size = target.stat().st_size
    print(f"built {target}  ({size / 1024:.1f} KiB, {len(files)} files)")
    print(f"plugin id: {plugin_id}  version: {version}")
    for rel in files:
        print(f"  + {rel.as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
