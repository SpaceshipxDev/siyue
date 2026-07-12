from __future__ import annotations

import numpy as np
import torch
from lightglue import LightGlue, SuperPoint


class FeatureModels:
    superpoint_version = "cvg/superpoint_v1"
    lightglue_version = "cvg/lightglue-superpoint"

    def __init__(self, max_keypoints: int = 1024, resize: int = 960):
        self.resize = resize
        self.extractor = SuperPoint(max_num_keypoints=max_keypoints).eval().cpu()
        self.matcher = LightGlue(
            features="superpoint", depth_confidence=0.90, width_confidence=0.95,
            filter_threshold=0.10,
        ).eval().cpu()

    @staticmethod
    def image_tensor(rgb: np.ndarray) -> torch.Tensor:
        return torch.from_numpy(rgb.copy()).permute(2, 0, 1).float().div_(255.0)

    @torch.inference_mode()
    def extract(self, rgb: np.ndarray) -> dict[str, torch.Tensor]:
        result = self.extractor.extract(self.image_tensor(rgb), resize=self.resize)
        return {key: value.detach().cpu() for key, value in result.items() if torch.is_tensor(value)}

    @staticmethod
    def to_numpy(features: dict[str, torch.Tensor]) -> dict[str, np.ndarray]:
        return {key: value.cpu().numpy() for key, value in features.items()}

    @staticmethod
    def from_numpy(features: dict[str, np.ndarray]) -> dict[str, torch.Tensor]:
        return {key: torch.from_numpy(value) for key, value in features.items()}

    @torch.inference_mode()
    def match(self, first: dict[str, torch.Tensor], second: dict[str, torch.Tensor]) -> tuple[np.ndarray, np.ndarray]:
        output = self.matcher({"image0": first, "image1": second})
        pairs = output["matches"][0].cpu()
        if pairs.numel() == 0:
            return np.empty((0, 2), np.float32), np.empty((0, 2), np.float32)
        points0 = first["keypoints"][0, pairs[:, 0]].cpu().numpy().astype(np.float32)
        points1 = second["keypoints"][0, pairs[:, 1]].cpu().numpy().astype(np.float32)
        return points0, points1
