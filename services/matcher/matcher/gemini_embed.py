"""Optional Gemini Embedding 2 fallback for non-planar/deformed pages."""

from __future__ import annotations

import base64
import os
from pathlib import Path

import cv2
import httpx
import numpy as np


class GeminiEmbedder:
    model_name = "gemini-embedding-2"

    def __init__(self, api_key: str | None = None, dimensions: int = 768):
        self.api_key = api_key or os.getenv("GEMINI_API_KEY")
        self.dimensions = dimensions
        self.endpoint = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.model_name}:embedContent"
        )

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    def embed(self, rgb: np.ndarray) -> np.ndarray:
        if not self.api_key:
            raise RuntimeError("GEMINI_API_KEY is not configured")
        height, width = rgb.shape[:2]
        scale = min(1.0, 512 / max(height, width))
        if scale < 1.0:
            rgb = cv2.resize(
                rgb, (round(width * scale), round(height * scale)),
                interpolation=cv2.INTER_AREA,
            )
        ok, encoded = cv2.imencode(
            ".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR),
            [cv2.IMWRITE_JPEG_QUALITY, 80],
        )
        if not ok:
            raise ValueError("could not encode Gemini embedding image")
        body = {
            "content": {"parts": [{"inline_data": {
                "mime_type": "image/jpeg",
                "data": base64.b64encode(encoded).decode(),
            }}]},
            "output_dimensionality": self.dimensions,
        }
        response = httpx.post(
            self.endpoint, headers={"x-goog-api-key": self.api_key},
            json=body, timeout=30,
        )
        response.raise_for_status()
        vector = np.asarray(response.json()["embedding"]["values"], np.float32)
        vector /= max(float(np.linalg.norm(vector)), 1e-9)
        return vector
