from __future__ import annotations

import cv2
import numpy as np
import torch

from .features import FeatureModels


def grid_coverage(points: np.ndarray, width: float, height: float) -> int:
    if len(points) == 0 or width <= 0 or height <= 0:
        return 0
    x = np.clip((points[:, 0] / width * 4).astype(int), 0, 3)
    y = np.clip((points[:, 1] / height * 4).astype(int), 0, 3)
    return len(set((y * 4 + x).tolist()))


def edge_agreement(reference: np.ndarray, query: np.ndarray, homography: np.ndarray) -> float:
    qh, qw = query.shape[:2]
    ref_gray = cv2.cvtColor(reference, cv2.COLOR_RGB2GRAY)
    query_gray = cv2.cvtColor(query, cv2.COLOR_RGB2GRAY)
    warped = cv2.warpPerspective(ref_gray, homography, (qw, qh))
    mask = cv2.warpPerspective(np.full(ref_gray.shape, 255, np.uint8), homography, (qw, qh)) > 0
    if mask.sum() < 1000:
        return 0.0
    edge_ref = cv2.Canny(warped, 70, 160) > 0
    edge_query = cv2.Canny(query_gray, 70, 160) > 0
    kernel = np.ones((5, 5), np.uint8)
    ref_dilated = cv2.dilate(edge_ref.astype(np.uint8), kernel) > 0
    query_dilated = cv2.dilate(edge_query.astype(np.uint8), kernel) > 0
    ref_hits = (edge_ref & query_dilated & mask).sum() / max(1, (edge_ref & mask).sum())
    query_hits = (edge_query & ref_dilated & mask).sum() / max(1, (edge_query & mask).sum())
    return float((ref_hits + query_hits) / 2)


def verify_pair(
    models: FeatureModels,
    reference_rgb: np.ndarray,
    query_rgb: np.ndarray,
    reference_features: dict[str, torch.Tensor],
    query_features: dict[str, torch.Tensor],
    reprojection_threshold: float = 3.0,
) -> dict[str, float | int]:
    ref_points, query_points = models.match(reference_features, query_features)
    total = len(ref_points)
    if total < 4:
        return {"score": 0.0, "inliers": 0, "inlier_ratio": 0.0, "coverage": 0, "edge_agreement": 0.0}
    method = getattr(cv2, "USAC_MAGSAC", cv2.RANSAC)
    homography, mask = cv2.findHomography(ref_points, query_points, method, reprojection_threshold)
    if homography is None or mask is None:
        return {"score": 0.0, "inliers": 0, "inlier_ratio": 0.0, "coverage": 0, "edge_agreement": 0.0}
    inlier_mask = mask.ravel().astype(bool)
    inliers = int(inlier_mask.sum())
    ratio = inliers / total
    image_size = reference_features["image_size"][0].cpu().numpy()
    coverage = grid_coverage(ref_points[inlier_mask], float(image_size[0]), float(image_size[1]))
    # Keypoint coordinates are in the extractor-resized frames. Edge comparison is
    # performed at that same scale to keep H valid and the CPU cost bounded.
    rw, rh = map(int, image_size)
    query_size = query_features["image_size"][0].cpu().numpy()
    qw, qh = map(int, query_size)
    ref_small = cv2.resize(reference_rgb, (rw, rh), interpolation=cv2.INTER_AREA)
    query_small = cv2.resize(query_rgb, (qw, qh), interpolation=cv2.INTER_AREA)
    edge = edge_agreement(ref_small, query_small, homography)
    score = float(inliers * ratio * coverage * edge)
    return {"score": score, "inliers": inliers, "inlier_ratio": ratio, "coverage": coverage, "edge_agreement": edge}
