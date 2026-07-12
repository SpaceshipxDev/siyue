from __future__ import annotations

import io
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageOps


@dataclass
class Preprocessed:
    rgb: np.ndarray
    quad_cropped: bool = False


def decode_image(data: bytes) -> np.ndarray:
    if not data:
        raise ValueError("empty image")
    try:
        with Image.open(io.BytesIO(data)) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            return np.asarray(im)
    except Exception as exc:
        raise ValueError(f"invalid image: {exc}") from exc


def encode_jpeg(rgb: np.ndarray, quality: int = 94) -> bytes:
    ok, buf = cv2.imencode(
        ".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR),
        [int(cv2.IMWRITE_JPEG_QUALITY), quality],
    )
    if not ok:
        raise ValueError("could not encode image")
    return buf.tobytes()


def resize_long_side(rgb: np.ndarray, max_side: int) -> np.ndarray:
    h, w = rgb.shape[:2]
    scale = min(1.0, max_side / max(h, w))
    if scale == 1.0:
        return np.ascontiguousarray(rgb)
    return cv2.resize(rgb, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)


def _order_quad(points: np.ndarray) -> np.ndarray:
    points = points.astype(np.float32)
    s = points.sum(axis=1)
    d = np.diff(points, axis=1).ravel()
    return np.array([points[np.argmin(s)], points[np.argmin(d)], points[np.argmax(s)], points[np.argmax(d)]])


def document_crop(rgb: np.ndarray) -> np.ndarray | None:
    """Conservative paper-quad detection; absence is a normal outcome."""
    h, w = rgb.shape[:2]
    small = resize_long_side(rgb, 900)
    scale = w / small.shape[1]
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 40, 120)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:12]:
        if cv2.contourArea(contour) < 0.35 * small.shape[0] * small.shape[1]:
            continue
        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.025 * peri, True)
        if len(approx) != 4 or not cv2.isContourConvex(approx):
            continue
        quad = _order_quad(approx[:, 0, :]) * scale
        tl, tr, br, bl = quad
        out_w = int(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl)))
        out_h = int(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr)))
        if min(out_w, out_h) < 300:
            continue
        dst = np.array([[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]], np.float32)
        return cv2.warpPerspective(rgb, cv2.getPerspectiveTransform(quad, dst), (out_w, out_h))
    return None


def preprocess(data: bytes, max_side: int = 1600, crop_quad: bool = False) -> Preprocessed:
    rgb = decode_image(data)
    cropped = document_crop(rgb) if crop_quad else None
    return Preprocessed(resize_long_side(cropped if cropped is not None else rgb, max_side), cropped is not None)


def rotate_quadrants(rgb: np.ndarray) -> list[np.ndarray]:
    return [np.ascontiguousarray(np.rot90(rgb, k)) for k in range(4)]
