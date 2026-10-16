#!/usr/bin/env python3
"""Copy data using SQLite backups without changing services.

Secret settings and account credentials are excluded and require a separate
secure backup. Sources are not guaranteed to share one transaction snapshot.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import uuid

SKIP = {"kimlik", ".auth", ".runtime", ".oturum", ".codex", ".claude",
        ".ssh", ".aws", ".git", "node_modules", "auth.json", ".credentials.json"}


def skipped(path):
    return (path.is_symlink() or path.name in SKIP or path.name.startswith(".env")
            or path.name.startswith("db-backup-")
            or path.name.endswith(("-wal", "-shm", "-journal")))


def copy_tree(source, destination):
    if source.is_symlink():
        raise ValueError("Source directories cannot be symlinks.")
    if not source.exists():
        return 0
    if not source.is_dir():
        raise ValueError("Backup sources must be directories.")
    count = 0
    for directory, dirs, files in os.walk(source, followlinks=False):
        directory = Path(directory)
        dirs[:] = sorted(d for d in dirs if not skipped(directory / d))
        for name in sorted(files):
            path = directory / name
            if skipped(path) or not path.is_file():
                continue
            target = destination / path.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if path.suffix in (".sqlite", ".sqlite3", ".db"):
                src = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
                try:
                    dst = sqlite3.connect(target)
                    try:
                        src.backup(dst)
                    finally:
                        dst.close()
                finally:
                    src.close()
            else:
                shutil.copyfile(path, target)
            count += 1
    return count


def backup(repo, output, work, keep=14, folders=None):
    if keep < 1:
        raise ValueError("At least one backup must be retained.")
    sources = [(repo / "office/data", "ofis-veri"), (repo / "tududi/db", "tududi-db"),
               (repo / "tududi/uploads", "tududi-yuklemeler"), (work / "ofis", "ajan-klasorleri")]
    if folders:
        sources.append((folders, "bagli-klasorler"))
    output = output.resolve()
    for source, _ in sources:
        if output.is_relative_to(source.resolve()):
            raise ValueError("Backup destinations cannot be inside a source directory.")
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = output / (stamp + "-" + uuid.uuid4().hex[:8])
    target.mkdir(mode=0o700)
    try:
        count = sum(copy_tree(source, target / name) for source, name in sources)
        if not count:
            raise ValueError("No data found to back up.")
        (target / "yedek.json").write_text(json.dumps({"uygulama": "piksel-ofis-backup-v1", "dosya": count}) + "\n")
    except Exception:
        shutil.rmtree(target)
        raise
    # Prune only completed backups marked by this tool.
    snapshots = []
    for path in sorted(output.iterdir()):
        if path.is_symlink() or not path.is_dir() or not re.fullmatch(r"\d{8}T\d{6}Z-[a-f0-9]{8}", path.name):
            continue
        marker = path / "yedek.json"
        if marker.is_symlink() or not marker.is_file():
            continue
        try:
            if json.loads(marker.read_text()).get("uygulama") == "piksel-ofis-backup-v1":
                snapshots.append(path)
        except (ValueError, OSError):
            continue
    # Random suffixes within one second do not indicate creation order.
    snapshots.sort(key=lambda p: (p.stat().st_mtime_ns, p.name))
    for old in snapshots[:-keep]:
        if old != target:
            shutil.rmtree(old)
    return target, count


def main():
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Pixel Office data backup. Does not start or stop services.", add_help=False)
    parser.add_argument("-h", "--help", action="help", help="Show this help message")
    parser.add_argument("--output", type=Path, default=repo / "yedek/gunluk", help="Backup destination")
    parser.add_argument("--work-dir", type=Path, default=repo / "runner/work", help="The runner’s OFIS_WORK_DIR value")
    parser.add_argument("--folders-dir", type=Path, help="Optional extra data directory; not for credentials")
    parser.add_argument("--keep", type=int, default=14, help="Number of completed backups to retain")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        _, count = backup(repo, args.output, args.work_dir, args.keep, args.folders_dir)
        print(f"Backup complete: {count} data files. Store secret settings and credentials separately.")
    except Exception:
        # The error object may contain source data or sensitive filenames.
        parser.exit(1, "Backup failed. Check sources, destination and permissions.\n")


if __name__ == "__main__":
    main()
