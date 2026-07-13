from __future__ import annotations

import os
from functools import lru_cache

import httpx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile

from matcher import MatcherEngine

app = FastAPI(title="Yingma Page Matcher", version="1.0.0")
MAX_UPLOAD = 30 * 1024 * 1024


@lru_cache(maxsize=1)
def engine() -> MatcherEngine:
    return MatcherEngine()


def authorize(authorization: str | None = Header(default=None)) -> None:
    expected = os.getenv("MATCHER_TOKEN", "dev")
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="invalid bearer token", headers={"WWW-Authenticate": "Bearer"})


async def _read_upload(image: UploadFile) -> bytes:
    data = await image.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "image exceeds 30 MB")
    return data


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.get("/stats", dependencies=[Depends(authorize)])
def stats() -> dict:
    return engine().stats()


@app.post("/register", dependencies=[Depends(authorize)])
async def register(
    page_id: str = Form(...), component_id: str = Form(...), kind: str = Form(...),
    image: UploadFile | None = File(default=None), image_url: str | None = Form(default=None),
) -> dict:
    if bool(image) == bool(image_url):
        raise HTTPException(422, "provide exactly one of image or image_url")
    if image:
        data = await _read_upload(image)
    else:
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
                response = await client.get(image_url)
                response.raise_for_status()
                data = response.content
            if len(data) > MAX_UPLOAD:
                raise HTTPException(413, "image exceeds 30 MB")
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(400, f"could not fetch image_url: {exc}") from exc
    existed = engine().bank.get(page_id) is not None
    try:
        engine().register(data, page_id, component_id, kind)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"ok": True, "page_id": page_id, "replaced": existed}


@app.post("/match", dependencies=[Depends(authorize)])
async def match(image: UploadFile = File(...)) -> dict:
    try:
        return engine().match(await _read_upload(image))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.delete("/pages/{page_id}", dependencies=[Depends(authorize)])
def delete_page(page_id: str) -> dict:
    deleted = engine().bank.delete(page_id)
    if not deleted:
        raise HTTPException(404, "page_id not found")
    return {"ok": True, "page_id": page_id}
