"""Lightweight learned paper-corner detector for cluttered phone captures."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import torch
from torchvision.models import mobilenet_v3_small


INPUT_SIZE = 256
MEAN = torch.tensor([0.485, 0.456, 0.406])[:, None, None]
STD = torch.tensor([0.229, 0.224, 0.225])[:, None, None]


class CornerNet(torch.nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.backbone = mobilenet_v3_small(weights=None)
        self.backbone.classifier[-1] = torch.nn.Linear(
            self.backbone.classifier[-1].in_features, 8,
        )

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        return torch.sigmoid(self.backbone(value)).reshape(-1, 4, 2)


def image_tensor(rgb: np.ndarray) -> torch.Tensor:
    resized = cv2.resize(rgb, (INPUT_SIZE, INPUT_SIZE), interpolation=cv2.INTER_AREA)
    value = torch.from_numpy(resized.copy()).permute(2, 0, 1).float().div_(255.0)
    return (value - MEAN) / STD


class DocumentDetector:
    def __init__(self, model_path: Path):
        self.available = model_path.exists()
        self.model: CornerNet | None = None
        if self.available:
            self.model = CornerNet().eval().cpu()
            self.model.load_state_dict(torch.load(model_path, map_location="cpu", weights_only=True))

    @torch.inference_mode()
    def corners(self, rgb: np.ndarray) -> np.ndarray | None:
        if self.model is None:
            return None
        height, width = rgb.shape[:2]
        normalized = self.model(image_tensor(rgb)[None])[0].numpy()
        points = normalized * np.asarray([width, height], np.float32)
        area = abs(float(cv2.contourArea(points.astype(np.float32))))
        if area < 0.025 * width * height or not cv2.isContourConvex(points.astype(np.float32)):
            return None
        return points.astype(np.float32)


    def rectify(
        self, rgb: np.ndarray, width: int = 768, padding: float = 0.0,
        max_area_ratio: float = 0.72, min_area_ratio: float = 0.18,
    ) -> np.ndarray | None:
        points = self.corners(rgb)
        if points is None:
            return None
        image_area = float(rgb.shape[0] * rgb.shape[1])
        area_ratio = abs(float(cv2.contourArea(points))) / max(image_area, 1.0)
        if area_ratio >= max_area_ratio:
            # Already document-centred. Re-warping a nearly full-frame page adds
            # interpolation error and amplifies corner-regression noise.
            return None
        if area_ratio < min_area_ratio:
            # A quad this small is either a corner-regression hallucination or
            # a sheet too distant to match anyway. Warping it produces a
            # garbage crop that poisons whatever consumes it (a real bank
            # reference was destroyed this way), so keep the raw frame.
            return None
        # Slight outward padding prevents small corner-regression errors from
        # cutting off page content. SSCD tolerates a narrow background rim much
        # better than a missing title block or document edge.
        center = points.mean(axis=0)
        points = center + (points - center) * (1.0 + padding)
        tl, tr, br, bl = points
        top = np.linalg.norm(tr - tl)
        bottom = np.linalg.norm(br - bl)
        left = np.linalg.norm(bl - tl)
        right = np.linalg.norm(br - tr)
        ratio = max(left, right) / max(max(top, bottom), 1.0)
        height = int(np.clip(round(width * ratio), round(width * 0.55), round(width * 2.0)))
        target = np.asarray(
            [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
            np.float32,
        )
        transform = cv2.getPerspectiveTransform(points, target)
        return cv2.warpPerspective(rgb, transform, (width, height), flags=cv2.INTER_CUBIC)
