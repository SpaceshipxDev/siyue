from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import torch


class SSCDEmbedder:
    model_name = "facebookresearch/sscd_disc_mixup"

    def __init__(self, model_path: Path, image_size: int = 320):
        if not model_path.exists():
            raise FileNotFoundError(f"SSCD model missing: {model_path}; run ./run.sh setup")
        torch.set_num_threads(max(1, min(4, torch.get_num_threads())))
        self.model = torch.jit.load(str(model_path), map_location="cpu").eval()
        self.image_size = image_size
        self.mean = torch.tensor([0.485, 0.456, 0.406])[:, None, None]
        self.std = torch.tensor([0.229, 0.224, 0.225])[:, None, None]

    def _tensor(self, rgb: np.ndarray) -> torch.Tensor:
        resized = cv2.resize(rgb, (self.image_size, self.image_size), interpolation=cv2.INTER_AREA)
        value = torch.from_numpy(resized.copy()).permute(2, 0, 1).float().div_(255.0)
        return (value - self.mean) / self.std

    @torch.inference_mode()
    def embed_rotations(self, rotations: list[np.ndarray]) -> np.ndarray:
        batch = torch.stack([self._tensor(image) for image in rotations])
        vectors = self.model(batch).float()
        vectors = torch.nn.functional.normalize(vectors, dim=1)
        return vectors.cpu().numpy().astype(np.float32)

    def embed(self, rgb: np.ndarray) -> np.ndarray:
        return self.embed_rotations([rgb])[0]
