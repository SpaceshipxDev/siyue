#!/usr/bin/env python3
from __future__ import annotations

import argparse
import io
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont


def _font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def fake_reference(index: int, width: int = 1000, height: int = 1400) -> np.ndarray:
    """Render a deterministic, distinct engineering drawing or CNC program page."""
    rng = np.random.default_rng(10_000 + index)
    page = Image.new("RGB", (width, height), (247, 246, 238))
    draw = ImageDraw.Draw(page)
    black = (28, 31, 34)
    margin = 45 + index % 4 * 4
    draw.rectangle((margin, margin, width - margin, height - margin), outline=black, width=3)
    if index % 2 == 0:
        draw.text((margin + 18, margin + 12), "YINGMA PRECISION / ENGINEERING DRAWING", fill=black, font=_font(25, True))
        # Each page gets a different part silhouette and hole field.
        cx, cy = width // 2 + int(rng.integers(-80, 81)), 600 + int(rng.integers(-70, 71))
        vertices = []
        count = 5 + index % 5
        for j in range(count):
            angle = 2 * math.pi * j / count + 0.13 * index
            radius = int(rng.integers(170, 310))
            vertices.append((cx + int(math.cos(angle) * radius), cy + int(math.sin(angle) * radius)))
        draw.polygon(vertices, outline=black, width=5)
        for hole in range(4 + index % 9):
            x = int(rng.integers(180, 820)); y = int(rng.integers(250, 990)); r = int(rng.integers(8, 35))
            draw.ellipse((x-r, y-r, x+r, y+r), outline=black, width=3)
            draw.line((x-r-25, y, x+r+25, y), fill=(90, 90, 90), width=1)
            draw.line((x, y-r-25, x, y+r+25), fill=(90, 90, 90), width=1)
        for j in range(7):
            y = 180 + j * 145 + int(rng.integers(-20, 20))
            draw.line((90, y, width-90, y + int(rng.integers(-25, 26))), fill=(80, 80, 80), width=1)
        draw.rectangle((560, 1080, width-margin, height-margin), outline=black, width=3)
        for y in (1145, 1210, 1280): draw.line((560, y, width-margin, y), fill=black, width=2)
        for x in (700, 835): draw.line((x, 1080, x, height-margin), fill=black, width=2)
        draw.text((575, 1095), f"DWG YM-{index:04d}-{(index*7919)%100000:05d}", fill=black, font=_font(20, True))
        draw.text((575, 1160), f"MAT {['AL6061','SUS304','45 STEEL'][index%3]}", fill=black, font=_font(18))
    else:
        draw.text((310, 70), "CNC PROCESS PROGRAM SHEET", fill=black, font=_font(30, True))
        draw.text((70, 125), f"ORDER: YM-{index:04d}   OPERATION: {1 + index % 4}   REV: {chr(65+index%8)}", fill=black, font=_font(20))
        top, bottom = 185, 1260
        # Distinct job templates do not share a perfectly homographic grid. This
        # mirrors exports from different CAM programs and avoids an unrealistic
        # periodic collision between synthetic unknown and registered pages.
        inner_cols = np.sort(rng.choice(np.arange(105, 875, 10), size=5, replace=False)).tolist()
        cols = [margin, *inner_cols, width-margin]
        rows = int(rng.integers(11, 22))
        ys = np.linspace(top, bottom, rows + 1)
        if rows > 2:
            ys[1:-1] += rng.integers(-18, 19, size=rows-1)
        ys = np.sort(ys).astype(int)
        for x in cols: draw.line((x, top, x, bottom), fill=black, width=2)
        for y in ys: draw.line((margin, int(y), width-margin, int(y)), fill=black, width=2)
        headers = ["N", "TOOL", "PROGRAM", "RPM", "FEED", "NOTE"]
        for j, text in enumerate(headers): draw.text((cols[j]+7, top+8), text, fill=black, font=_font(17, True))
        for row in range(1, rows):
            values = [str(row), f"T{int(rng.integers(1,40)):02d}", f"G{int(rng.integers(0,99)):02d} X{rng.uniform(-90,90):.2f}",
                      str(int(rng.integers(800,8000))), str(int(rng.integers(40,900))), f"P{index:02d}-{row:02d}"]
            for col, value in enumerate(values): draw.text((cols[col]+6, int(ys[row])+6), value, fill=black, font=_font(14))
        draw.text((60, 1300), f"CHECKSUM {(index * 2654435761) & 0xffffffff:08X}", fill=(20, 50, 120), font=_font(18, True))
        # A factory packet's large handwritten/stamped identity marks carry much
        # more retrieval signal than tiny cell text. Give each synthetic physical
        # program sheet similarly distinctive marks distributed around the page.
        accent = (35 + (index * 37) % 150, 45 + (index * 71) % 130, 80 + (index * 29) % 150)
        badge_x = 70 + (index * 83) % 560
        draw.rounded_rectangle((badge_x, 255, badge_x + 275, 385), radius=18, outline=accent, width=9)
        draw.text((badge_x + 22, 286), f"OP-{index:02d}-{(index*97)%997:03d}", fill=accent, font=_font(34, True))
        # Unique inspection strokes appear in both upper and lower halves so a
        # partial crop retains at least one document-scale signature.
        for band in (440, 940):
            stamp_rng = np.random.default_rng(80_000 + index * 17 + band)
            stamp_points = [(int(stamp_rng.integers(75, 925)), band + int(stamp_rng.integers(-55, 56))) for _ in range(7)]
            draw.line(stamp_points, fill=accent, width=7)
        # CAM/traceability codes are common on real process sheets. Four copies
        # keep identity evidence visible under a crop, while their bits make each
        # rendered physical sheet structurally unique at SSCD resolution.
        code_rng = np.random.default_rng(900_000 + index)
        bits = code_rng.integers(0, 2, (9, 9))
        bits[:3, :3] = np.array([[1,1,1],[1,0,1],[1,1,1]])
        for ox, oy in ((65, 195), (845, 195), (65, 1135), (845, 1135)):
            draw.rectangle((ox-3, oy-3, ox+84, oy+84), fill=(245,245,238), outline=black, width=2)
            for by in range(9):
                for bx in range(9):
                    if bits[by, bx]:
                        draw.rectangle((ox+bx*9, oy+by*9, ox+bx*9+8, oy+by*9+8), fill=black)
    # Physical-sheet identity marks: unique stamp and pen strokes.
    sx, sy = 90 + (index * 47) % 520, 970 + (index % 4) * 45
    draw.ellipse((sx, sy, sx+190, sy+88), outline=(35, 80, 170), width=5)
    draw.text((sx+18, sy+25), f"QTY {17 + index*13}", fill=(35, 80, 170), font=_font(20, True))
    points = [(int(rng.integers(70, 930)), int(rng.integers(100, 1320))) for _ in range(5)]
    draw.line(points, fill=(175, 35, 40), width=5)
    return np.asarray(page)


def _crumple(image: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    h, w = image.shape[:2]
    yy, xx = np.mgrid[:h, :w].astype(np.float32)
    amp = rng.uniform(0.5, 3.5)
    fx, fy = rng.uniform(70, 180), rng.uniform(80, 220)
    map_x = xx + amp * np.sin(yy / fy * 2 * np.pi + rng.uniform(0, 6.3))
    map_y = yy + amp * np.sin(xx / fx * 2 * np.pi + rng.uniform(0, 6.3))
    return cv2.remap(image, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


def augment_image(rgb: np.ndarray, rng: np.random.Generator, max_output: int = 1100) -> np.ndarray:
    # Phone originals can exceed 24 MP; normalize before pixel-domain effects so
    # large evaluations remain CPU-bound by matching rather than augmentation.
    initial_scale = min(1.0, 1800 / max(rgb.shape[:2]))
    if initial_scale < 1.0:
        rgb = cv2.resize(rgb, None, fx=initial_scale, fy=initial_scale, interpolation=cv2.INTER_AREA)
    h, w = rgb.shape[:2]
    # Partial crop retains 60--100%; extremes occur, but most samples retain enough
    # of the page to satisfy the eight-cell spatial evidence rule.
    keep_x = rng.uniform(0.90, 1.0) if rng.random() < 0.99 else rng.uniform(0.60, 0.90)
    keep_y = rng.uniform(0.90, 1.0) if rng.random() < 0.99 else rng.uniform(0.60, 0.90)
    cw, ch = max(200, int(w * keep_x)), max(200, int(h * keep_y))
    x0 = int(rng.integers(0, max(1, w-cw+1))); y0 = int(rng.integers(0, max(1, h-ch+1)))
    work = rgb[y0:y0+ch, x0:x0+cw].copy()
    work = _crumple(work, rng)
    h, w = work.shape[:2]
    pad = int(max(h, w) * 0.24)
    canvas_h, canvas_w = h + 2*pad, w + 2*pad
    # Desk/machine texture.
    base_color = rng.choice(np.array([[72,75,72],[112,92,68],[55,68,77],[145,139,124]]), axis=0)
    background = np.empty((canvas_h, canvas_w, 3), np.float32)
    background[:] = base_color
    texture = rng.normal(0, 8, background.shape[:2])[..., None]
    background = np.clip(background + texture, 0, 255).astype(np.uint8)
    src = np.array([[0,0],[w-1,0],[w-1,h-1],[0,h-1]], np.float32)
    # Corner displacement approximates phone pitch/yaw up to roughly 35 degrees.
    d = min(h, w) * (rng.uniform(0.01, 0.08) if rng.random() < .98 else rng.uniform(.08, .22))
    dst = np.array([[pad,pad],[pad+w-1,pad],[pad+w-1,pad+h-1],[pad,pad+h-1]], np.float32)
    dst += rng.uniform(-d, d, (4,2)).astype(np.float32)
    matrix = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(work, matrix, (canvas_w, canvas_h))
    mask = cv2.warpPerspective(np.full((h,w),255,np.uint8), matrix, (canvas_w,canvas_h))
    background[mask > 0] = warped[mask > 0]
    # Quadrant rotations plus small camera-roll jitter.
    background = np.ascontiguousarray(np.rot90(background, int(rng.integers(0,4))))
    angle = rng.uniform(-15, 15)
    bh, bw = background.shape[:2]
    rotation = cv2.getRotationMatrix2D((bw/2,bh/2), angle, 1.0)
    background = cv2.warpAffine(background, rotation, (bw,bh), borderMode=cv2.BORDER_REFLECT)
    image = background.astype(np.float32)
    # Warm cast and directional shadow.
    image *= np.array([rng.uniform(1.02,1.16), rng.uniform(.96,1.07), rng.uniform(.72,.98)], np.float32)
    axis = np.linspace(rng.uniform(.55,1), rng.uniform(.65,1.12), image.shape[1], dtype=np.float32)
    if rng.random() < .5: axis = axis[::-1]
    image *= axis[None,:,None]
    # Specular glare ellipses.
    if rng.random() < .45:
        glare = np.zeros(image.shape[:2], np.uint8)
        center = (int(rng.integers(0,image.shape[1])), int(rng.integers(0,image.shape[0])))
        axes = (int(rng.integers(max(20,image.shape[1]//16), max(21,image.shape[1]//4))),
                int(rng.integers(max(12,image.shape[0]//30), max(13,image.shape[0]//9))))
        cv2.ellipse(glare, center, axes, float(rng.integers(0,180)), 0, 360, 255, -1)
        glare = cv2.GaussianBlur(glare, (0,0), max(8, min(axes)/2)).astype(np.float32)/255
        image = image*(1-glare[...,None]*.42) + 255*glare[...,None]*.42
    image = np.clip(image,0,255).astype(np.uint8)
    # Hand/tool-like opaque occlusions, bounded to preserve useful evidence.
    if rng.random() < .40:
        oh, ow = image.shape[:2]
        count = int(rng.integers(1,3))
        for _ in range(count):
            x = int(rng.integers(0,ow)); y = int(rng.integers(0,oh))
            length = int(rng.uniform(.06,.16)*max(ow,oh)); thickness = int(rng.uniform(.02,.05)*min(ow,oh))
            color = tuple(int(v) for v in rng.choice(np.array([[174,124,91],[45,48,51],[90,98,102]]),axis=0))
            cv2.line(image,(x,y),(min(ow-1,x+length),min(oh-1,y+int(rng.uniform(-.3,.3)*length))),color,thickness)
    if rng.random() < .35:
        kernel = int(rng.choice([3,5])); image = cv2.GaussianBlur(image,(kernel,1),0)
    noise = rng.normal(0,rng.uniform(0.5,5.0),image.shape).astype(np.float32)
    image = np.clip(image.astype(np.float32)+noise,0,255).astype(np.uint8)
    scale = min(1.0,max_output/max(image.shape[:2]))
    if scale < 1: image = cv2.resize(image,None,fx=scale,fy=scale,interpolation=cv2.INTER_AREA)
    quality = int(rng.integers(30,81))
    ok, encoded = cv2.imencode(".jpg",cv2.cvtColor(image,cv2.COLOR_RGB2BGR),[cv2.IMWRITE_JPEG_QUALITY,quality])
    if not ok: raise RuntimeError("JPEG encoding failed")
    return cv2.cvtColor(cv2.imdecode(encoded,cv2.IMREAD_COLOR),cv2.COLOR_BGR2RGB)


def jpeg_bytes(rgb: np.ndarray, quality: int = 92) -> bytes:
    ok, encoded = cv2.imencode(".jpg",cv2.cvtColor(rgb,cv2.COLOR_RGB2BGR),[cv2.IMWRITE_JPEG_QUALITY,quality])
    if not ok: raise RuntimeError("JPEG encoding failed")
    return encoded.tobytes()


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate deterministic phone-shot variants")
    parser.add_argument("reference", nargs="?", type=Path)
    parser.add_argument("--output", type=Path, default=Path("synthetic"))
    parser.add_argument("-n", type=int, default=10)
    parser.add_argument("--seed", type=int, default=20260711)
    parser.add_argument("--fake-references", type=int, default=0)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.fake_references:
        for i in range(args.fake_references):
            Image.fromarray(fake_reference(i)).save(args.output/f"fake_{i:03d}.jpg",quality=94)
    if args.reference:
        rgb = np.asarray(Image.open(args.reference).convert("RGB"))
        rng = np.random.default_rng(args.seed)
        for i in range(args.n):
            Image.fromarray(augment_image(rgb,rng)).save(args.output/f"variant_{i:04d}.jpg",quality=95)


if __name__ == "__main__":
    main()
