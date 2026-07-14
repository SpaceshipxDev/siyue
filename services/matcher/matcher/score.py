from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass
class Candidate:
    page_id: str
    component_id: str
    score: float
    cosine: float
    inliers: int
    inlier_ratio: float
    coverage: int
    edge_agreement: float
    # Reference page kind ("drawing" / "program" / …). Program sheets share a
    # printed template, so a geometric match against one is weak identity
    # evidence — callers gate on this.
    kind: str = "other"

    def public(self) -> dict:
        value = asdict(self)
        value["score"] = round(self.score, 3)
        value["cosine"] = round(self.cosine, 4)
        value["inlier_ratio"] = round(self.inlier_ratio, 4)
        value["edge_agreement"] = round(self.edge_agreement, 4)
        return value
