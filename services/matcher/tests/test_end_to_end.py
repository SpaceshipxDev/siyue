from pathlib import Path

import pytest

from matcher.config import Settings
from matcher.engine import MatcherEngine
from scripts.synth import augment_image, jpeg_bytes
from matcher.preprocess import decode_image
import numpy as np

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.slow
def test_register_and_match_real_photo(tmp_path: Path) -> None:
    model = ROOT / "models" / "sscd_disc_mixup.torchscript.pt"
    if not model.exists():
        pytest.skip("run ./run.sh setup to download models")
    engine = MatcherEngine(Settings(data_dir=tmp_path / "data", model_dir=ROOT / "models"))
    path = ROOT / "testdata" / "real" / "IMG_7293.jpeg"
    engine.register(path.read_bytes(), "img_7293", "component-7293", "drawing")
    source = decode_image(path.read_bytes())
    query = jpeg_bytes(augment_image(source, np.random.default_rng(83)))
    result = engine.match(query)
    assert result["best"]["page_id"] == "img_7293"
    assert result["decision"] == "match"
