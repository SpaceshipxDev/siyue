"""Train the lightweight paper-corner detector from SmartDoc15 annotations."""

from __future__ import annotations

import csv
import gzip
import os
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("TORCH_HOME", str(ROOT / "models" / "torch-cache"))

import cv2
import numpy as np
import torch
from torch.utils.data import DataLoader, Dataset
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small

sys.path.insert(0, str(ROOT))

from matcher.doc_detector import CornerNet, image_tensor  # noqa: E402

DATASET = ROOT / "testdata" / "external" / "smartdoc15-ch1"
FRAMES = DATASET / "frames"
MODEL = ROOT / "models" / "document_corners_mobilenet_v3_small.pt"
SEED = 20260712


class Frames(Dataset):
    def __init__(self, rows: list[dict[str, str]], augment: bool):
        self.rows = rows
        self.augment = augment

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor]:
        row = self.rows[index]
        bgr = cv2.imread(str(FRAMES / row["image_path"]), cv2.IMREAD_COLOR)
        if bgr is None:
            raise RuntimeError(f"could not read {row['image_path']}")
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        height, width = rgb.shape[:2]
        points = np.asarray([
            [float(row["tl_x"]) / width, float(row["tl_y"]) / height],
            [float(row["tr_x"]) / width, float(row["tr_y"]) / height],
            [float(row["br_x"]) / width, float(row["br_y"]) / height],
            [float(row["bl_x"]) / width, float(row["bl_y"]) / height],
        ], np.float32)
        if self.augment:
            gain = random.uniform(0.7, 1.25)
            bias = random.uniform(-25, 25)
            rgb = np.clip(rgb.astype(np.float32) * gain + bias, 0, 255).astype(np.uint8)
            if random.random() < 0.35:
                rgb = cv2.GaussianBlur(rgb, (3, 3), random.uniform(0.2, 1.2))
        return image_tensor(rgb), torch.from_numpy(points)


def rows() -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    selected = {str(path.relative_to(FRAMES)) for path in FRAMES.glob("background*/*/*.jpeg")}
    train: list[dict[str, str]] = []
    validation: list[dict[str, str]] = []
    with gzip.open(DATASET / "metadata.csv.gz", "rt", newline="") as handle:
        for row in csv.DictReader(handle):
            if row["image_path"] not in selected:
                continue
            # Hold out one member of every document type: six unseen page identities.
            target = validation if row["model_name"].endswith("005") else train
            target.append(row)
    return train, validation


def polygon_iou(prediction: np.ndarray, truth: np.ndarray) -> float:
    prediction = np.clip(prediction, 0, 1).astype(np.float32)
    truth = truth.astype(np.float32)
    intersection = cv2.intersectConvexConvex(prediction, truth)[0]
    union = cv2.contourArea(prediction) + cv2.contourArea(truth) - intersection
    return float(intersection / max(union, 1e-9))


@torch.inference_mode()
def validate(model: CornerNet, loader: DataLoader, device: torch.device) -> tuple[float, float]:
    model.eval()
    values: list[float] = []
    for images, targets in loader:
        predictions = model(images.to(device)).cpu().numpy()
        for prediction, truth in zip(predictions, targets.numpy()):
            values.append(polygon_iou(prediction, truth))
    return float(np.median(values)), float(np.mean(np.asarray(values) >= 0.8))


def main() -> None:
    random.seed(SEED)
    np.random.seed(SEED)
    torch.manual_seed(SEED)
    train_rows, validation_rows = rows()
    train_loader = DataLoader(Frames(train_rows, True), batch_size=32, shuffle=True, num_workers=0)
    validation_loader = DataLoader(Frames(validation_rows, False), batch_size=32, num_workers=0)
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")

    pretrained = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.DEFAULT)
    model = CornerNet()
    pretrained.classifier[-1] = torch.nn.Linear(pretrained.classifier[-1].in_features, 8)
    model.backbone = pretrained
    model.to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-4, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=30)
    loss_fn = torch.nn.SmoothL1Loss(beta=0.03)
    best_iou = -1.0

    for epoch in range(1, 31):
        model.train()
        losses = []
        for images, targets in train_loader:
            optimizer.zero_grad(set_to_none=True)
            loss = loss_fn(model(images.to(device)), targets.to(device))
            loss.backward()
            optimizer.step()
            losses.append(float(loss.detach().cpu()))
        scheduler.step()
        median_iou, pass_rate = validate(model, validation_loader, device)
        print(
            f"epoch={epoch:02d} loss={np.mean(losses):.5f} "
            f"heldout_median_iou={median_iou:.4f} heldout_iou80={pass_rate:.2%}",
            flush=True,
        )
        if median_iou > best_iou:
            best_iou = median_iou
            MODEL.parent.mkdir(exist_ok=True)
            torch.save({key: value.detach().cpu() for key, value in model.state_dict().items()}, MODEL)
    print(f"saved {MODEL}; best held-out median IoU={best_iou:.4f}")


if __name__ == "__main__":
    main()
