import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("backup", Path(__file__).with_name("backup.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BackupTest(unittest.TestCase):
    def test_live_sqlite_and_private_files(self):
        base = Path(__file__).resolve().parents[1] / ".test-data"
        base.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as tmp:
            root = Path(tmp)
            data = root / "office/data"
            data.mkdir(parents=True)
            db = sqlite3.connect(data / "ofis.sqlite")
            try:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("CREATE TABLE kayit (deger TEXT)")
                db.execute("INSERT INTO kayit VALUES ('kayitli veri')")
                db.commit()
                work = root / "work"
                agent = work / "ofis/ajan"
                agent.mkdir(parents=True)
                (agent / "teslim.txt").write_text("tamam")
                (agent / ".env").write_text("SAHTE_GIZLI=deneme")
                (agent / "auth.json").write_text("sahte kimlik")
                (agent / "baglanti").symlink_to(data / "ofis.sqlite")
                untouched = root / "yedek/elle-saklanan"
                untouched.mkdir(parents=True)
                destination, count = module.backup(root, root / "yedek", work, keep=1)
                self.assertEqual(count, 2)
                snapshot = sqlite3.connect(destination / "ofis-veri/ofis.sqlite")
                try:
                    self.assertEqual(snapshot.execute("SELECT deger FROM kayit").fetchone()[0], "kayitli veri")
                finally:
                    snapshot.close()
                files = [p.name for p in destination.rglob("*")]
                for name in [".env", "auth.json", "baglanti", "ofis.sqlite-wal", "ofis.sqlite-shm"]:
                    self.assertNotIn(name, files)
                again, _ = module.backup(root, root / "yedek", work, keep=1)
                self.assertTrue(again.is_dir())
                self.assertFalse(destination.exists())
                self.assertTrue(untouched.is_dir())
                with self.assertRaises(ValueError):
                    module.backup(root, data / "yedek", work)
            finally:
                db.close()


if __name__ == "__main__":
    os.umask(0o077)
    unittest.main()
