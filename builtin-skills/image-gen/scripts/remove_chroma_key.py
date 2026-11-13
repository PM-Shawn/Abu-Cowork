#!/usr/bin/env python3
"""Turn a flat chroma-key background (green or magenta) into real transparency.

Adapted from the imagegen skill of OpenAI Codex (scripts/remove_chroma_key.py,
Copyright OpenAI, Apache License 2.0, see ../LICENSE.txt and ../NOTICE.md).
Changes: vectorised with numpy (the original loops over pixels in Python),
auto key-color sampling that ignores transparent border pixels, proper edge
decontamination, an optional "border only" mode that keeps key-colored areas
enclosed by the subject, tolerant input modes, and ASCII-only messages that
are safe on a Windows console.

Needs only Pillow and numpy. Exit codes: 0 ok, 1 bad input or output problem,
2 bad command line (argparse), 3 nothing to remove (the background is not the
key color; in auto mode: not a flat green or magenta screen).

Model: every pixel is C = a*F + (1-a)*B with B the background and F the subject.
Pixels well inside the subject keep alpha 255 untouched. Only the thin band
between the subject and the background is un-mixed: F and B are estimated from
the nearest clean subject / background pixels, alpha is where C lies between
them, and the output color is the un-mixed color blended toward the estimated F
where alpha is small (so JPEG chroma bleed cannot turn the rim orange or pink).
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image, ImageFilter, ImageOps
except ImportError as exc:  # pragma: no cover - the bundled Python has both
    print(f"Error: Pillow and numpy are required ({exc}).", file=sys.stderr)
    raise SystemExit(1)

NAMED_KEYS = {"green": (0, 255, 0), "magenta": (255, 0, 255)}
KEY_DOMINANCE_THRESHOLD = 16.0  # key-channel lead that counts as key-tinted near the edge
STRONG_DOMINANCE = 48.0   # key-channel lead that marks a pixel as clearly key-colored
ALPHA_NOISE_FLOOR = 8
EDGE_BAND_PX = 4          # width of the band that is un-mixed
ESTIMATE_RADIUS = 5       # window for the nearest clean subject / background colors
MIN_SEPARATION_SQ = 900.0  # |F-B|^2 below this: colors too close to un-mix reliably
AUTO_KEY_MAX_DIST = 100   # auto mode only accepts a border this close to green or magenta
AUTO_KEY_MIN_SHARE = 0.10
PARTIAL_WARN_SHARE = 0.25
INSIDE_WARN_SHARE = 0.02    # see-through pixels far from any transparent pixel
INSIDE_FAR_PX = 6
CHUNK_ROWS = 256
DEFAULT_MAX_PIXELS = 40_000_000  # Seedream tops out near 16.7 MP


class ChromaError(Exception):
    """A problem the caller can fix; main() prints it and exits 1."""


# ---------------------------------------------------------------- loading


def _to_rgba(image: Image.Image) -> Image.Image:
    """RGBA for any mode Pillow can open (palette, gray, CMYK, 16-bit ...)."""
    if image.mode in ("I;16", "I;16L", "I;16B", "I", "F"):
        arr = np.asarray(image).astype(np.float64)
        top = arr.max() if arr.size else 0.0
        if top > 255:
            arr = arr * (255.0 / top)
        gray = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "L")
        return gray.convert("RGBA")
    if image.mode == "P" and "transparency" in image.info:
        return image.convert("RGBA")
    if image.mode in ("1", "L", "LA", "La", "P", "RGB", "RGBA", "RGBa", "CMYK", "YCbCr", "LAB", "HSV"):
        return image.convert("RGBA")
    raise ChromaError(f"Unsupported image mode: {image.mode}")


def _open(path: Path, max_pixels: int) -> tuple[np.ndarray, bytes | None]:
    """RGBA array (EXIF orientation applied like a viewer) and the ICC profile, if any."""
    try:
        with Image.open(path) as image:
            width, height = image.size
            if width * height > max_pixels:
                raise ChromaError(
                    f"Image is {width}x{height} ({width * height} pixels), over the "
                    f"--max-pixels limit of {max_pixels}. Downscale it first."
                )
            image.load()
            icc = image.info.get("icc_profile")
            if icc and bytes(icc[16:20]) != b"RGB ":
                icc = None  # a CMYK or gray profile is wrong for an RGBA output
            try:
                image = ImageOps.exif_transpose(image)
            except (OSError, ValueError, SyntaxError, TypeError):
                pass  # a broken EXIF block must not stop the cut-out
            rgba = _to_rgba(image)
    except ChromaError:
        raise
    except Image.DecompressionBombError as exc:
        raise ChromaError(f"Image is too large to open safely: {exc}") from exc
    except (OSError, ValueError, SyntaxError) as exc:
        raise ChromaError(f"Cannot read {path.name} as an image: {exc}") from exc
    return np.array(rgba, dtype=np.uint8), icc


# ------------------------------------------------------------- key color


def parse_key_color(raw: str) -> tuple[int, int, int] | None:
    """None means 'sample it from the image border'."""
    value = raw.strip().lower()
    if value == "auto":
        return None
    if value in NAMED_KEYS:
        return NAMED_KEYS[value]
    match = re.fullmatch(r"#?([0-9a-f]{6})", value)
    if not match:
        raise ChromaError("--key-color must be auto, green, magenta or a hex value like #00ff00.")
    h = match.group(1)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def sample_border_key(rgba: np.ndarray) -> tuple[int, int, int] | None | str:
    """Auto key: the flat green or magenta screen along the border.

    Returns None when the border is already transparent, the screen color (the
    median of the border pixels near green / near magenta, whichever has more),
    or the string "no-screen" when neither covers a meaningful share of the
    border. The subject can cover most of the border and the screen is still
    found, because only pixels near the two screen colors vote.
    """
    height, width = rgba.shape[:2]
    band = max(1, min(width, height, 6))
    parts = [rgba[:band].reshape(-1, 4), rgba[-band:].reshape(-1, 4),
             rgba[:, :band].reshape(-1, 4), rgba[:, -band:].reshape(-1, 4)]
    border = np.concatenate(parts)
    border = border[border[:, 3] >= 128][:, :3].astype(np.int16)
    if border.shape[0] == 0:
        return None
    best: tuple[int, tuple[int, int, int]] | None = None
    for ref in NAMED_KEYS.values():
        near = border[np.abs(border - np.array(ref, dtype=np.int16)).max(axis=1) <= AUTO_KEY_MAX_DIST]
        if near.shape[0] >= AUTO_KEY_MIN_SHARE * border.shape[0] and (best is None or near.shape[0] > best[0]):
            med = np.median(near, axis=0)
            best = (near.shape[0], (int(round(med[0])), int(round(med[1])), int(round(med[2]))))
    return best[1] if best else "no-screen"


def _spill_channels(key: tuple[int, int, int]) -> list[int]:
    top = max(key)
    if top < 128:
        return []
    return [i for i, v in enumerate(key) if v >= top - 16 and v >= 128]


# -------------------------------------------------------------- the math


def _dominance(rgb: np.ndarray, key: tuple[int, int, int]) -> np.ndarray | None:
    """How much the key's own channel(s) stand above the other channels (float32)."""
    spill = _spill_channels(key)
    if not spill:
        return None
    others = [i for i in range(3) if i not in spill]
    strength = rgb[..., spill].min(axis=-1).astype(np.float32)
    rest = rgb[..., others].max(axis=-1).astype(np.float32) if others else np.zeros_like(strength)
    return strength - rest


def _old_alpha(rgb: np.ndarray, key: tuple[int, int, int], t0: float, t1: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(alpha float 0-1, key-like mask, clearly-key mask) from distance and key dominance alone.

    Key-like pixels (close to the key or tinted by it) get the dominance alpha;
    everything else is 1.0. The clearly-key mask is stricter and decides what
    counts as "clean background" and, inverted, as solid subject: a white
    subject with a mild green cast is key-like but not clearly key.
    """
    dist = np.abs(rgb.astype(np.int16) - np.array(key, dtype=np.int16)).max(axis=-1).astype(np.float32)
    ratio = np.clip((dist - t0) / max(t1 - t0, 1e-6), 0.0, 1.0)
    soft = ratio * ratio * (3.0 - 2.0 * ratio)
    dom = _dominance(rgb, key)
    if dom is None:
        strong = dist <= 32
        return np.where(strong, soft, 1.0).astype(np.float32), strong, strong
    spill_ch = _spill_channels(key)
    others = [i for i in range(3) if i not in spill_ch]
    # A pure blend of subject F and key K has dominance (1-a) * dominance(K), whatever F is
    # (white included), so alpha = 1 - dom / dominance(K).
    key_dom = float(min(key[i] for i in spill_ch) - (max(key[i] for i in others) if others else 0))
    denom = max(1.0, key_dom)
    dom_alpha = np.where(dom <= 0, 1.0, 1.0 - np.minimum(1.0, dom / denom))
    keylike = (dist <= 32) | (dom >= KEY_DOMINANCE_THRESHOLD)
    clearly = (dist <= 32) | (dom >= STRONG_DOMINANCE)
    return np.where(keylike, np.minimum(soft, dom_alpha), 1.0).astype(np.float32), keylike, clearly


def _dilate(mask: np.ndarray, n: int) -> np.ndarray:
    """3x3 box dilation, n times, on a bool mask."""
    for _ in range(n):
        m = mask.copy()
        m[1:] |= mask[:-1]
        m[:-1] |= mask[1:]
        m2 = m.copy()
        m[:, 1:] |= m2[:, :-1]
        m[:, :-1] |= m2[:, 1:]
        mask = m
    return mask


def _erode(mask: np.ndarray, n: int) -> np.ndarray:
    return ~_dilate(~mask, n)


def _box_sum(values: np.ndarray, r: int, ys: np.ndarray, xs: np.ndarray) -> np.ndarray:
    """Sum of int32 `values` over the (2r+1)^2 window around each (y, x), via cumulative sums (exact in int32)."""
    h, w = values.shape
    cs = np.zeros((h + 1, w), np.int32)
    np.cumsum(values, axis=0, out=cs[1:])
    rows = cs[np.minimum(np.arange(h) + r + 1, h)] - cs[np.maximum(np.arange(h) - r, 0)]
    del cs
    cs = np.zeros((h, w + 1), np.int32)
    np.cumsum(rows, axis=1, out=cs[:, 1:])
    del rows
    hi = np.minimum(xs + r + 1, w)
    lo = np.maximum(xs - r, 0)
    return (cs[ys, hi] - cs[ys, lo]).astype(np.float32)


def _window_means(rgba: np.ndarray, source: np.ndarray, ys: np.ndarray, xs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Mean color of the `source` pixels in the window around each (y, x), and how many there were.

    Box sums over cumulative sums: the cost is a few passes over the image, not
    one gather per window offset, so a worst-case picture (a fine mesh of
    subject and screen, millions of edge pixels) stays fast.
    """
    count = _box_sum(source.astype(np.int32), ESTIMATE_RADIUS, ys, xs)
    mean = np.zeros((ys.shape[0], 3), np.float32)
    for ch in range(3):
        mean[:, ch] = _box_sum(np.where(source, rgba[..., ch], 0).astype(np.int32), ESTIMATE_RADIUS, ys, xs)
    return mean / np.maximum(count, 1.0)[:, None], count


def _runs_reach(cand: np.ndarray, reached: np.ndarray) -> np.ndarray:
    """Along each row, mark every run of `cand` that already holds a reached pixel."""
    padded = np.zeros((cand.shape[0], cand.shape[1] + 1), dtype=bool)
    padded[:, :-1] = cand
    flat = padded.ravel()
    starts = flat & ~np.concatenate(([False], flat[:-1]))
    run_id = np.cumsum(starts) * flat
    seed = np.zeros_like(padded)
    seed[:, :-1] = reached
    hit = np.zeros(int(run_id.max()) + 1, dtype=bool)
    hit[run_id[seed.ravel() & flat]] = True
    hit[0] = False
    return hit[run_id].reshape(padded.shape)[:, :-1]


def border_connected(cand: np.ndarray) -> np.ndarray:
    """Pixels of `cand` that touch the image border through other `cand` pixels."""
    if not cand.any():
        return cand
    seed = np.zeros_like(cand)
    seed[0, :] = seed[-1, :] = True
    seed[:, 0] = seed[:, -1] = True
    reached = seed & cand
    for _ in range(500):
        before = int(reached.sum())
        reached = _runs_reach(cand, reached)
        reached = _runs_reach(cand.T, reached.T).T
        if int(reached.sum()) == before:
            break
    return reached


def remove_key(
    rgba: np.ndarray,
    key: tuple[int, int, int],
    *,
    tolerance: float = 24.0,
    softness: float = 72.0,
    hard: bool = False,
    border_only: bool = False,
    despill: bool = True,
    contract: int = 0,
    feather: float = 0.0,
) -> tuple[np.ndarray, int]:
    """Return (new RGBA array, number of pixels that were keyed out)."""
    height, width = rgba.shape[:2]
    out = rgba.copy()
    t0, t1 = float(tolerance), float(tolerance) + float(softness)
    alpha_f = np.empty((height, width), np.float32)
    strong = np.empty((height, width), bool)
    clearly = np.empty((height, width), bool)
    for top in range(0, height, CHUNK_ROWS):
        chunk = rgba[top:top + CHUNK_ROWS, :, :3]
        if hard:
            dist = np.abs(chunk.astype(np.int16) - np.array(key, dtype=np.int16)).max(axis=-1)
            alpha_f[top:top + CHUNK_ROWS] = np.where(dist <= t0, 0.0, 1.0)
            strong[top:top + CHUNK_ROWS] = clearly[top:top + CHUNK_ROWS] = dist <= t0
        else:
            alpha_f[top:top + CHUNK_ROWS], strong[top:top + CHUNK_ROWS], clearly[top:top + CHUNK_ROWS] = (
                _old_alpha(chunk, key, t0, t1))

    unmixed = np.zeros(0, dtype=bool)
    if not hard:
        # Clean subject = solid, not key-like, with room around it (so JPEG specks and hair do not count).
        core = _erode(~clearly, 1)
        alpha_f[core] = 1.0  # the inside of the subject is never softened
        # Clean background = confidently transparent key-like pixels.
        bg = strong & (alpha_f <= ALPHA_NOISE_FLOOR / 255.0)
        zone = _dilate(core, EDGE_BAND_PX) & ~core
        ys, xs = np.nonzero(zone)
        if ys.size:
            fg_est, fg_w = _window_means(rgba, core, ys, xs)
            bg_est, bg_w = _window_means(rgba, bg, ys, xs)
            color = rgba[ys, xs, :3].astype(np.float32)
            sep = fg_est - bg_est
            sep_sq = (sep * sep).sum(axis=1)
            usable = (fg_w > 0) & (bg_w > 0) & (sep_sq >= MIN_SEPARATION_SQ)
            a = np.clip(((color - bg_est) * sep).sum(axis=1) / np.maximum(sep_sq, 1.0), 0.0, 1.0)
            a = np.where(a < 0.06, 0.0, np.where(a > 0.97, 1.0, a))
            # A pixel inside the key tolerance is background, whatever the estimate says.
            near_key = np.abs(color - np.array(key, dtype=np.float32)).max(axis=1) <= t0
            a = np.where(near_key, 0.0, a)
            # Un-mix against the local background; lean on the estimated subject color where alpha is small.
            safe = np.maximum(a, 1.0 / 255.0)[:, None]
            raw = np.clip((color - (1.0 - a)[:, None] * bg_est) / safe, 0, 255)
            w = np.clip((a - 0.5) / 0.5, 0.0, 1.0)[:, None]
            fg_col = w * raw + (1.0 - w) * fg_est
            keep = usable
            alpha_f[ys[keep], xs[keep]] = a[keep]
            if despill:
                partial = keep & (a < 0.99)
                new = np.where(partial[:, None], fg_col, color)
                out[ys, xs, :3] = np.rint(np.clip(new, 0, 255)).astype(np.uint8)
            unmixed = np.zeros((height, width), bool)
            unmixed[ys[keep & (a < 0.99)], xs[keep & (a < 0.99)]] = True
        del core, bg, zone

    key_alpha = np.rint(alpha_f * 255).astype(np.uint8)
    del alpha_f, strong, clearly

    if border_only:
        # Only pixels linked to the border through (partly) key-like pixels
        # are background; a green area fenced in by the subject stays.
        linked = border_connected(key_alpha < 255)
        restore = (key_alpha < 255) & ~linked
        key_alpha = np.where(linked, key_alpha, 255).astype(np.uint8)
        out[restore] = rgba[restore]
        del linked, restore

    alpha = np.rint(key_alpha.astype(np.float32) * (rgba[..., 3].astype(np.float32) / 255.0))
    alpha[(alpha > 0) & (alpha <= ALPHA_NOISE_FLOOR)] = 0
    alpha = alpha.astype(np.uint8)

    if despill:
        partial = (alpha > 0) & (alpha < 252)
        if isinstance(unmixed, np.ndarray) and unmixed.size:
            todo = partial & ~unmixed
        else:
            todo = partial
        if todo.any():
            a = alpha[todo].astype(np.float32)[:, None] / 255.0
            color = rgba[..., :3][todo].astype(np.float32)
            # C = a*F + (1-a)*K  ->  F = (C - (1-a)*K) / a
            fg = (color - (1.0 - a) * np.array(key, dtype=np.float32)) / np.maximum(a, 1.0 / 255.0)
            out[..., :3][todo] = np.rint(np.clip(fg, 0, 255)).astype(np.uint8)
        # Cap the key-colored channel(s) of every partial pixel at the others, so no tint is left.
        spill = _spill_channels(key)
        others = [i for i in range(3) if i not in spill]
        mixed = todo  # pixels the edge band un-mixed already carry the local subject color
        if mixed.any() and spill and others:
            fg = out[..., :3][mixed].astype(np.float32)
            cap = np.maximum(fg[:, others].max(axis=1) - 1.0, 0.0)
            for ch in spill:
                fg[:, ch] = np.minimum(fg[:, ch], cap)
            out[..., :3][mixed] = np.rint(fg).astype(np.uint8)

    alpha_img = Image.fromarray(alpha, "L")
    for _ in range(max(0, contract)):
        alpha_img = alpha_img.filter(ImageFilter.MinFilter(3))
    if feather > 0:
        alpha_img = alpha_img.filter(ImageFilter.GaussianBlur(radius=feather))
    alpha = np.array(alpha_img, dtype=np.uint8)

    out[..., 3] = alpha
    out[alpha == 0] = 0  # no stray color under fully transparent pixels
    return out, int((alpha == 0).sum())


def _see_through_inside(alpha: np.ndarray) -> int:
    """Partly transparent pixels farther than INSIDE_FAR_PX from every fully transparent pixel."""
    partial = (alpha > 0) & (alpha < 255)
    if not partial.any():
        return 0
    near = _dilate(alpha == 0, INSIDE_FAR_PX)
    return int((partial & ~near).sum())


# -------------------------------------------------------------------- CLI


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Remove a flat chroma-key background and write a PNG/WebP with alpha.")
    p.add_argument("--input", required=True, help="Input image.")
    p.add_argument("--out", help="Output .png or .webp (default: <input name>-transparent.png next to the input).")
    p.add_argument("--key-color", default="auto",
                   help="auto (sample the border, default), green, magenta, or hex like #00ff00.")
    p.add_argument("--tolerance", type=float, default=24.0,
                   help="Distance from the key that is fully transparent (0-255, default 24).")
    p.add_argument("--softness", type=float, default=72.0,
                   help="Width of the soft edge ramp beyond the tolerance (default 72).")
    p.add_argument("--hard", action="store_true", help="Hard cut at the tolerance, no soft edge.")
    p.add_argument("--border-only", action="store_true",
                   help="Only remove key-colored areas connected to the image border; keep enclosed ones.")
    p.add_argument("--no-despill", dest="despill", action="store_false",
                   help="Do not remove the key-color tint from edge pixels.")
    p.add_argument("--edge-contract", type=int, default=0, help="Shrink the cut-out by N pixels (0-16) to drop a halo.")
    p.add_argument("--edge-feather", type=float, default=0.0, help="Blur the alpha edge by this radius (0-64).")
    p.add_argument("--max-pixels", type=int, default=DEFAULT_MAX_PIXELS, help="Refuse larger images.")
    p.add_argument("--force", action="store_true", help="Replace --out if it already exists (default: refuse).")
    return p


def _validate(args: argparse.Namespace) -> tuple[Path, Path]:
    if not 0 <= args.tolerance <= 255:
        raise ChromaError("--tolerance must be between 0 and 255.")
    if not 0 <= args.softness <= 255:
        raise ChromaError("--softness must be between 0 and 255.")
    if not 0 <= args.edge_contract <= 16:
        raise ChromaError("--edge-contract must be between 0 and 16.")
    if not 0 <= args.edge_feather <= 64:
        raise ChromaError("--edge-feather must be between 0 and 64.")
    src = Path(args.input)
    if not src.is_file():
        raise ChromaError(f"Input image not found: {src}")
    out = Path(args.out) if args.out else src.with_name(src.stem + "-transparent.png")
    if out.suffix.lower() not in (".png", ".webp"):
        raise ChromaError("--out must end in .png or .webp so the alpha channel is kept.")
    same = out.resolve() == src.resolve()
    if not same and out.exists():
        try:
            same = os.path.samefile(out, src)  # case-insensitive disks, links, hard links
        except OSError:
            pass
    if same:
        raise ChromaError("--out must differ from --input (the original is never overwritten).")
    if out.exists() and not args.force:
        raise ChromaError(f"{out} already exists. Use a new --out name, or pass --force to replace it.")
    return src, out


def _save(array: np.ndarray, out: Path, icc: bytes | None) -> None:
    """Write next to the target first, then move into place, so a failure leaves no half file."""
    tmp = out.with_name(f".{out.name}.{os.getpid()}.tmp")
    kwargs: dict[str, object] = {"format": "PNG" if out.suffix.lower() == ".png" else "WEBP"}
    if icc:
        kwargs["icc_profile"] = icc
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(array, "RGBA").save(tmp, **kwargs)
        os.replace(tmp, out)
    except OSError as exc:
        raise ChromaError(f"Cannot write {out}: {exc.strerror or exc}. Choose another --out folder or name.") from exc
    except ValueError as exc:  # e.g. WebP is limited to 16383 px per side
        raise ChromaError(f"Cannot save {out.name}: {exc}. Use a .png output or downscale the picture.") from exc
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def run(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    src, out = _validate(args)
    rgba, icc = _open(src, args.max_pixels)
    total = rgba.shape[0] * rgba.shape[1]

    key = parse_key_color(args.key_color)
    if key is None:
        sampled = sample_border_key(rgba)
        if sampled is None:
            _save(rgba, out, icc)
            print(f"Wrote {out.name}: the border is already transparent, nothing to remove.")
            return 0
        if isinstance(sampled, str):
            print("Error: the background is not a flat green (#00FF00) or magenta (#FF00FF) screen; "
                  "nothing was written. Regenerate the picture on a pure green or magenta background, "
                  "or pass --key-color with the exact background color.", file=sys.stderr)
            return 3
        key = sampled
    result, removed = remove_key(
        rgba, key, tolerance=args.tolerance, softness=args.softness, hard=args.hard,
        border_only=args.border_only, despill=args.despill,
        contract=args.edge_contract, feather=args.edge_feather,
    )
    before = int((rgba[..., 3] == 0).sum())
    key_hex = "#%02x%02x%02x" % key
    if removed - before <= 0:
        print(f"Error: no pixel matched key color {key_hex}; nothing was written. "
              "Check the background color or pass --key-color / --tolerance.", file=sys.stderr)
        return 3
    _save(result, out, icc)
    alpha = result[..., 3]
    partial = int(((alpha > 0) & (alpha < 255)).sum())
    visible = int((alpha > 0).sum())
    print(f"Wrote {out}")
    print(f"Key color: {key_hex}")
    print(f"Transparent pixels: {removed}/{total} ({100.0 * removed / total:.1f}%)")
    print(f"Partially transparent pixels: {partial}/{total}")
    if removed > 0.97 * total:
        print("Warning: almost everything was removed; the subject may share the key color. "
              "Regenerate on a different key color.", file=sys.stderr)
    else:
        inside = _see_through_inside(alpha) if visible else 0
        if inside > INSIDE_WARN_SHARE * visible:
            print(f"Warning: {100.0 * inside / visible:.0f}% of the picture is see-through away from its edge. "
                  "A part of the subject probably has the key color (a green part on a green screen). "
                  "Regenerate on the other screen color (green <-> magenta).", file=sys.stderr)
        if visible and partial > PARTIAL_WARN_SHARE * visible:
            print(f"Warning: {100.0 * partial / visible:.0f}% of the visible picture is only partly transparent "
                  "(soft shadow, glass, smoke or a subject close to the key color). The cut-out is probably "
                  "not clean; regenerate with a hard-edged subject on a flat screen.", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # Windows consoles with a legacy code page
        except (AttributeError, ValueError):
            pass
    try:
        return run(argv)
    except ChromaError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except MemoryError:
        print("Error: not enough memory for this image; downscale it first.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
