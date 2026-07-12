from __future__ import annotations

import json
import shutil
import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass(frozen=True)
class Page:
    page_id: str
    component_id: str
    kind: str
    image_path: Path
    feature_path: Path
    embedding: np.ndarray


class PageBank:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.pages_dir = self.root / "pages"
        self.features_dir = self.root / "features"
        self.db_path = self.root / "bank.db"
        self.lock = threading.RLock()
        self.pages_dir.mkdir(parents=True, exist_ok=True)
        self.features_dir.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=30)
        connection.row_factory = sqlite3.Row
        return connection

    def _init_db(self) -> None:
        with self._connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS pages (
                page_id TEXT PRIMARY KEY, component_id TEXT NOT NULL, kind TEXT NOT NULL,
                image_path TEXT NOT NULL, feature_path TEXT NOT NULL,
                embedding BLOB NOT NULL, embedding_dim INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )""")

    @staticmethod
    def _slug(page_id: str) -> str:
        import hashlib
        return hashlib.sha256(page_id.encode()).hexdigest()[:24]

    def upsert(
        self, page_id: str, component_id: str, kind: str, image_rgb: np.ndarray,
        embedding: np.ndarray, features: dict[str, np.ndarray],
    ) -> None:
        slug = self._slug(page_id)
        image_rel = Path("pages") / f"{slug}.jpg"
        feature_rel = Path("features") / f"{slug}.npz"
        tmp_image = self.root / f".{slug}.jpg.tmp"
        tmp_features = self.root / f".{slug}.npz.tmp"
        ok, encoded = cv2.imencode(".jpg", cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 95])
        if not ok:
            raise ValueError("failed to store image")
        with self.lock:
            tmp_image.write_bytes(encoded.tobytes())
            with tmp_features.open("wb") as handle:
                np.savez_compressed(handle, **features)
            tmp_image.replace(self.root / image_rel)
            tmp_features.replace(self.root / feature_rel)
            vector = np.asarray(embedding, dtype=np.float32)
            with self._connect() as db:
                db.execute("""INSERT INTO pages
                    (page_id, component_id, kind, image_path, feature_path, embedding, embedding_dim)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(page_id) DO UPDATE SET component_id=excluded.component_id,
                    kind=excluded.kind, image_path=excluded.image_path,
                    feature_path=excluded.feature_path, embedding=excluded.embedding,
                    embedding_dim=excluded.embedding_dim, updated_at=CURRENT_TIMESTAMP""",
                    (page_id, component_id, kind, str(image_rel), str(feature_rel), vector.tobytes(), len(vector)))

    def delete(self, page_id: str) -> bool:
        with self.lock, self._connect() as db:
            row = db.execute("SELECT image_path, feature_path FROM pages WHERE page_id=?", (page_id,)).fetchone()
            if row is None:
                return False
            db.execute("DELETE FROM pages WHERE page_id=?", (page_id,))
            for column in ("image_path", "feature_path"):
                (self.root / row[column]).unlink(missing_ok=True)
            return True

    def all(self) -> list[Page]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM pages ORDER BY page_id").fetchall()
        return [Page(
            row["page_id"], row["component_id"], row["kind"],
            self.root / row["image_path"], self.root / row["feature_path"],
            np.frombuffer(row["embedding"], np.float32, row["embedding_dim"]).copy(),
        ) for row in rows]

    def get(self, page_id: str) -> Page | None:
        return next((page for page in self.all() if page.page_id == page_id), None)

    @staticmethod
    def load_image(page: Page) -> np.ndarray:
        bgr = cv2.imread(str(page.image_path), cv2.IMREAD_COLOR)
        if bgr is None:
            raise FileNotFoundError(page.image_path)
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

    @staticmethod
    def load_features(page: Page) -> dict[str, np.ndarray]:
        with np.load(page.feature_path) as archive:
            return {key: archive[key].copy() for key in archive.files}

    def count(self) -> int:
        with self._connect() as db:
            return int(db.execute("SELECT COUNT(*) FROM pages").fetchone()[0])

    def clear(self) -> None:
        with self.lock:
            if self.root.exists():
                shutil.rmtree(self.root)
            self.pages_dir.mkdir(parents=True)
            self.features_dir.mkdir(parents=True)
            self._init_db()
