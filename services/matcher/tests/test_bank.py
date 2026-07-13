from pathlib import Path

import numpy as np

from matcher.bank import PageBank


def test_bank_roundtrip_and_replace(tmp_path: Path) -> None:
    bank = PageBank(tmp_path / "bank")
    image = np.full((80, 60, 3), 220, np.uint8)
    vector = np.arange(8, dtype=np.float32)
    features = {
        "keypoints": np.zeros((1, 2, 2), np.float32),
        "descriptors": np.zeros((1, 2, 256), np.float32),
        "image_size": np.array([[60.0, 80.0]], np.float32),
    }
    bank.upsert("page/one", "component-a", "other", image, vector, features)
    page = bank.get("page/one")
    assert page is not None
    assert page.component_id == "component-a"
    np.testing.assert_array_equal(page.embedding, vector)
    np.testing.assert_array_equal(bank.load_features(page)["keypoints"], features["keypoints"])
    bank.upsert("page/one", "component-b", "drawing", image, vector + 1, features)
    assert bank.count() == 1
    assert bank.get("page/one").component_id == "component-b"
    assert bank.delete("page/one")
    assert not bank.delete("page/one")
