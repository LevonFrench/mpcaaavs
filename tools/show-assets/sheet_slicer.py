"""Conservative, local-only sprite-sheet slicer.

This tool only reads the supplied image and writes derived crops and metadata.
It does not fetch, execute, or interpret source programs embedded in assets.
Detected regions are candidates; labels and animation semantics require review.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import warnings
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


ROLES = ("actor", "projectile", "effect", "pickup", "prop", "background", "hud", "screen", "unsorted")
CHECKER_A = (190, 190, 190, 255)
CHECKER_B = (235, 235, 235, 255)


def safe_slug(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip().lower()).strip("-_")
    if not value:
        raise ValueError("--name must contain at least one letter or number")
    return value[:80]


def border_colour(rgb: np.ndarray) -> tuple[int, int, int]:
    h, w, _ = rgb.shape
    border = np.concatenate((rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]), axis=0)
    values = [tuple(int(c) for c in row) for row in border]
    return Counter(values).most_common(1)[0][0]


def remove_connected_border_colour(rgba: np.ndarray, tolerance: int = 0) -> tuple[np.ndarray, dict]:
    """Key opaque border-connected pixels near the modal border colour."""
    rgb = rgba[:, :, :3].astype(np.int16)
    key = border_colour(rgba[:, :, :3])
    near = np.max(np.abs(rgb - np.asarray(key, dtype=np.int16)), axis=2) <= tolerance
    h, w = near.shape
    parent: list[int] = []
    runs_by_row: list[list[tuple[int, int, int]]] = []

    def find(node: int) -> int:
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    previous: list[tuple[int, int, int]] = []
    for y, row in enumerate(near):
        padded = np.pad(row.astype(np.int8), (1, 1))
        changes = np.diff(padded)
        starts, ends = np.flatnonzero(changes == 1), np.flatnonzero(changes == -1)
        current: list[tuple[int, int, int]] = []
        for x0, x1 in zip(starts, ends):
            node = len(parent)
            parent.append(node)
            current.append((int(x0), int(x1), node))
            for px0, px1, pnode in previous:
                if px0 <= x1 and px1 >= x0:
                    union(node, pnode)
        runs_by_row.append(current)
        previous = current

    border_roots: set[int] = set()
    for y, row_runs in enumerate(runs_by_row):
        for x0, x1, node in row_runs:
            if y == 0 or y == h - 1 or x0 == 0 or x1 == w:
                border_roots.add(find(node))
    seen = np.zeros((h, w), dtype=np.bool_)
    for y, row_runs in enumerate(runs_by_row):
        for x0, x1, node in row_runs:
            if find(node) in border_roots:
                seen[y, x0:x1] = True

    keyed = rgba.copy()
    keyed[seen, 3] = 0
    return keyed, {"method": "modal_border_rgb_connected_8", "rgb": list(key), "tolerance_per_channel": tolerance, "keyed_pixels": int(seen.sum())}


def row_runs(mask: np.ndarray) -> list[list[tuple[int, int, int]]]:
    """Return foreground runs as (y, x_start, x_end_exclusive)."""
    runs: list[list[tuple[int, int, int]]] = []
    for y, row in enumerate(mask):
        padded = np.pad(row.astype(np.int8), (1, 1))
        changes = np.diff(padded)
        starts = np.flatnonzero(changes == 1)
        ends = np.flatnonzero(changes == -1)
        runs.append([(y, int(x0), int(x1)) for x0, x1 in zip(starts, ends)])
    return runs


class UnionFind:
    def __init__(self) -> None:
        self.parent: list[int] = []

    def add(self) -> int:
        i = len(self.parent)
        self.parent.append(i)
        return i

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def connected_boxes(mask: np.ndarray) -> list[dict]:
    """8-connected components via row-run unioning; bounded memory by runs."""
    uf = UnionFind()
    all_runs: list[tuple[int, int, int, int]] = []  # y, x0, x1, node
    by_row: list[list[tuple[int, int, int]]] = []
    previous: list[tuple[int, int, int]] = []  # x0, x1, node
    for y, runs in enumerate(row_runs(mask)):
        current: list[tuple[int, int, int]] = []
        for _, x0, x1 in runs:
            node = uf.add()
            current.append((x0, x1, node))
            all_runs.append((y, x0, x1, node))
            # 8-connected means a one-pixel diagonal touch joins adjacent rows.
            for px0, px1, pnode in previous:
                if px0 <= x1 and px1 >= x0:
                    uf.union(node, pnode)
        by_row.append(current)
        previous = current

    groups: dict[int, dict] = {}
    for y, x0, x1, node in all_runs:
        root = uf.find(node)
        g = groups.setdefault(root, {"x0": x0, "y0": y, "x1": x1, "y1": y + 1, "pixels": 0, "component_count": 1})
        g["x0"] = min(g["x0"], x0)
        g["y0"] = min(g["y0"], y)
        g["x1"] = max(g["x1"], x1)
        g["y1"] = max(g["y1"], y + 1)
        g["pixels"] += x1 - x0
    return sorted(groups.values(), key=lambda b: (b["y0"], b["x0"]))


def merge_nearby(boxes: list[dict], gap: int = 3) -> list[dict]:
    """Merge component bounds whose horizontal/vertical gap is at most gap."""
    work = [dict(b) for b in boxes]
    changed = True
    while changed:
        changed = False
        result: list[dict] = []
        while work:
            a = work.pop(0)
            i = 0
            while i < len(work):
                b = work[i]
                dx = max(0, a["x0"] - b["x1"], b["x0"] - a["x1"])
                dy = max(0, a["y0"] - b["y1"], b["y0"] - a["y1"])
                if dx <= gap and dy <= gap:
                    a["x0"] = min(a["x0"], b["x0"])
                    a["y0"] = min(a["y0"], b["y0"])
                    a["x1"] = max(a["x1"], b["x1"])
                    a["y1"] = max(a["y1"], b["y1"])
                    a["pixels"] += b["pixels"]
                    a["component_count"] += b.get("component_count", 1)
                    work.pop(i)
                    changed = True
                else:
                    i += 1
            result.append(a)
        work = result
    return sorted(work, key=lambda b: (b["y0"], b["x0"]))


def group_rows(boxes: list[dict]) -> list[list[dict]]:
    rows: list[list[dict]] = []
    row_centres: list[float] = []
    for box in sorted(boxes, key=lambda b: ((b["y0"] + b["y1"]) / 2, b["x0"])):
        cy = (box["y0"] + box["y1"]) / 2
        best = None
        best_score = -1.0
        for i, row in enumerate(rows):
            overlap = max(0, min(box["y1"], max(b["y1"] for b in row)) - max(box["y0"], min(b["y0"] for b in row)))
            denom = min(box["y1"] - box["y0"], max(b["y1"] - b["y0"] for b in row))
            score = overlap / max(1, denom)
            if score >= 0.35 and score > best_score:
                best, best_score = i, score
        if best is None:
            rows.append([box])
            row_centres.append(cy)
        else:
            rows[best].append(box)
            row_centres[best] = sum((b["y0"] + b["y1"]) / 2 for b in rows[best]) / len(rows[best])
    rows.sort(key=lambda row: min(b["y0"] for b in row))
    for row in rows:
        row.sort(key=lambda b: b["x0"])
    return rows


def likely_label_runs(rgba: np.ndarray, foreground: np.ndarray, components: list[dict]) -> list[dict]:
    """Find small bright, low-colour text runs immediately to the right of sprites."""
    rgb = rgba[:, :, :3].astype(np.int16)
    brightest = rgb.min(axis=2) >= 160
    low_chroma = (rgb.max(axis=2) - rgb.min(axis=2)) <= 48
    bright_mask = foreground & brightest & low_chroma
    text_boxes = merge_nearby(connected_boxes(bright_mask), gap=8)
    labels = []
    for candidate in text_boxes:
        width = candidate["x1"] - candidate["x0"]
        height = candidate["y1"] - candidate["y0"]
        if width < 14 or height < 4 or height > 18 or width / max(1, height) < 1.35 or candidate.get("component_count", 1) < 3:
            continue
        if candidate["pixels"] > width * height * 0.55:
            continue
        nearby_sprite = False
        for component in components:
            sx0, sy0, sx1, sy1 = (component[k] for k in ("x0", "y0", "x1", "y1"))
            if sy1 - sy0 < max(18, height * 1.8) or component["pixels"] < candidate["pixels"] * 2:
                continue
            vertical_overlap = max(0, min(candidate["y1"], sy1) - max(candidate["y0"], sy0))
            overlap_ratio = vertical_overlap / max(1, min(height, sy1 - sy0))
            dx = max(0, candidate["x0"] - sx1, sx0 - candidate["x1"])
            dy = max(0, candidate["y0"] - sy1, sy0 - candidate["y1"])
            if (overlap_ratio >= 0.35 and dx <= 36) or (dx <= 36 and dy <= 24):
                nearby_sprite = True
                break
        if nearby_sprite:
            labels.append(candidate)
    return labels


def checkerboard(size: tuple[int, int], tile: int = 12) -> Image.Image:
    w, h = size
    yy, xx = np.indices((h, w))
    pattern = ((xx // tile + yy // tile) % 2 == 0)
    arr = np.empty((h, w, 4), dtype=np.uint8)
    arr[:] = CHECKER_B
    arr[pattern] = CHECKER_A
    return Image.fromarray(arr, "RGBA")


def write_contact(entries: list[tuple[str, Image.Image, tuple[int, int, int, int]]], path: Path) -> None:
    if not entries:
        return
    cell_w, cell_h = 256, 220
    cols = max(1, min(8, 2048 // cell_w))
    rows = (len(entries) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cell_w, rows * cell_h), (30, 34, 40, 255))
    draw = ImageDraw.Draw(sheet)
    for i, (label, image, bounds) in enumerate(entries):
        x, y = (i % cols) * cell_w, (i // cols) * cell_h
        thumb = image.copy()
        thumb.thumbnail((cell_w - 16, cell_h - 54), Image.Resampling.NEAREST)
        bg = checkerboard((cell_w - 12, cell_h - 48))
        px = x + 6 + (bg.width - thumb.width) // 2
        py = y + 4 + (bg.height - thumb.height) // 2
        bg.alpha_composite(thumb, (px - (x + 6), py - (y + 4)))
        sheet.alpha_composite(bg, (x + 6, y + 4))
        draw.text((x + 6, y + cell_h - 39), label[:34], fill=(255, 255, 255, 255), font=ImageFont.load_default())
        draw.text((x + 6, y + cell_h - 22), f"{bounds[2]-bounds[0]}x{bounds[3]-bounds[1]} @ {bounds[0]},{bounds[1]}", fill=(190, 205, 220, 255), font=ImageFont.load_default())
    if sheet.width > 2048:
        raise RuntimeError("contact sheet width exceeded 2048 pixels")
    sheet.convert("RGB").save(path)


def available_output(requested: Path) -> Path:
    if not requested.exists():
        return requested
    for index in range(1, 10000):
        candidate = requested.with_name(f"{requested.name}-{index:03d}")
        if not candidate.exists():
            return candidate
    raise FileExistsError(f"could not find an unused output path beside {requested}")


def slice_sheet(sheet_path: Path, out_path: Path, role: str, name: str) -> Path:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(sheet_path) as source:
                source.load()
                original_size = source.size
                had_alpha = "A" in source.getbands() or "transparency" in source.info
                rgba = np.asarray(source.convert("RGBA"), dtype=np.uint8)
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError(f"Pillow decompression-bomb limit refused the image: {exc}") from exc

    keyed_info = None
    if not had_alpha:
        rgba, keyed_info = remove_connected_border_colour(rgba)
    alpha_mask = rgba[:, :, 3] > 0
    excluded_regions = []
    if role == "background":
        boxes = [{"x0": 0, "y0": 0, "x1": original_size[0], "y1": original_size[1], "pixels": int(alpha_mask.sum())}]
        grouping = "whole_image_background"
    else:
        initial_components = connected_boxes(alpha_mask)
        labels = likely_label_runs(rgba, alpha_mask, initial_components)
        for box in labels:
            x0, y0, x1, y1 = (box[k] for k in ("x0", "y0", "x1", "y1"))
            alpha_mask[y0:y1, x0:x1] = False
            excluded_regions.append({"source_bounds_xyxy": [x0, y0, x1, y1], "reason": "small_bright_low_chroma_run_aligned_near_larger_sprite; probable sheet label", "pixels_removed": int(box["pixels"])})
        boxes = merge_nearby(connected_boxes(alpha_mask), 3)
        grouping = "8_connected_components_then_merge_bounds_within_3px"

    output = available_output(out_path)
    output.mkdir(parents=True, exist_ok=False)
    clips_dir = output / "clips"
    clips_dir.mkdir()
    base = Image.fromarray(rgba, "RGBA")
    rows = group_rows(boxes)
    entries = []
    assets = []
    for row_index, row in enumerate(rows, 1):
        for box_index, box in enumerate(row, 1):
            x0, y0, x1, y1 = (box[k] for k in ("x0", "y0", "x1", "y1"))
            label = f"row-{row_index:02d}-box-{box_index:02d}"
            filename = f"{name}-{label}.png"
            crop = base.crop((x0, y0, x1, y1))
            crop.save(clips_dir / filename)
            entries.append((label, crop, (x0, y0, x1, y1)))
            assets.append({
                "label": label,
                "label_status": "tentative_unreviewed",
                "role": role,
                "file": f"clips/{filename}",
                "source_bounds_xyxy": [x0, y0, x1, y1],
                "source_pixels_in_components": int(box["pixels"]),
                "default_frame_duration_frames": 6,
                "anchor_estimate": {"kind": "bottom_center_feet_estimate", "x": (x1 - x0) / 2, "y": y1 - y0},
                "big": False,
                "loop": "unverified",
                "animation_correctness": "unverified",
            })
    contact_path = output / "contact-sheet.png"
    write_contact(entries, contact_path)
    metadata = {
        "schema_version": 1,
        "source_file_name": sheet_path.name,
        "source_size": {"width": original_size[0], "height": original_size[1]},
        "role": role,
        "name": name,
        "segmentation": {
            "alpha_present_and_used": had_alpha,
            "opaque_background_key": keyed_info,
            "component_connectivity": 8,
            "merge_gap_pixels": 3,
            "grouping": grouping,
            "excluded_regions": excluded_regions,
            "exclusion_note": "Only bright, low-chroma short text-like runs aligned beside larger sprite regions are filtered; small isolated components are retained.",
        },
        "defaults": {"frame_duration_frames": 6, "anchor": "bottom_center_feet_estimate", "big": False, "loop": "unverified"},
        "contact_sheet": "contact-sheet.png",
        "assets": assets,
    }
    (output / "clip.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sheet", required=True, type=Path, help="input image sheet (read-only)")
    parser.add_argument("--out", required=True, type=Path, help="output directory; existing content is preserved via a unique sibling path")
    parser.add_argument("--role", choices=ROLES, default="unsorted")
    parser.add_argument("--name", default=None, help="optional slug; defaults to the source filename")
    args = parser.parse_args(argv)
    if not args.sheet.is_file():
        parser.error(f"sheet is not a file: {args.sheet}")
    try:
        name = safe_slug(args.name if args.name is not None else args.sheet.stem)
        written = slice_sheet(args.sheet, args.out, args.role, name)
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"sheet_slicer: {exc}", file=sys.stderr)
        return 2
    print(written.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
