#!/usr/bin/env python3
"""
Documentation previews for the arrow pages.

Outputs (SVG, documentation aid only):
  arrow_2d_shapes.svg       four 2D shader shapes
  arrow_3d_overview.svg     four 3D styles: split head + single
  arrow_3d_<style>.svg      per-style split head / tail parts / single

The 2D shapes are drawn from the same 40 deg / 2.24 x pen formulas as the
DynamicArrowLayer shader; they are schematic, not a shader reimplementation.
The 3D previews project the generated OBJ triangles onto XZ.
"""

from __future__ import annotations

import argparse
import html
import json
import math
from pathlib import Path

PEN = 1.0
THICKNESS = 0.8
BEVEL = 0.08

TAIL_2D = 6.0
PEN_2D = 1.5
HEAD_PEN_2D = 1.5
HEAD_ARM = 2.24
HEAD_ANGLE = math.radians(40.0)
HEAD_SIZE_2D = HEAD_ARM * HEAD_PEN_2D
HEAD_WIDTH_2D = 2 * HEAD_ARM * math.tan(HEAD_ANGLE) * HEAD_PEN_2D
FILL_HEAD_SIZE = 6.5
FILL_HEAD_WIDTH = 0.8 * FILL_HEAD_SIZE
FILL_PEN = 2.0
MIN_BARE_STEM = PEN_2D + HEAD_SIZE_2D + PEN_2D / 2.0

COLORS = {
    "filled": "#4c78a8",
    "round-cap": "#f58518",
    "square-cap": "#54a24b",
    "vertical-cut": "#b279a2",
}
STYLES = ("filled", "round-cap", "square-cap", "vertical-cut")
LABELS = {
    "filled": "Filled",
    "round-cap": "Round-cap",
    "square-cap": "Square-cap",
    "vertical-cut": "Vertical-cut",
}


def read_obj(path: Path):
    verts = []
    faces = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("v "):
            parts = line.split()
            verts.append((float(parts[1]), float(parts[2]), float(parts[3])))
        elif line.startswith("f "):
            idx = [int(part.split("/")[0]) - 1 for part in line.split()[1:]]
            for i in range(1, len(idx) - 1):
                faces.append((idx[0], idx[i], idx[i + 1]))
    return verts, faces


def triangles_path(verts, faces, box, pad=10):
    """Project XZ triangles into a box; return (path, (minx, maxx, minz, maxz))."""
    xs = [v[0] for v in verts]
    zs = [v[2] for v in verts]
    minx, maxx = min(xs), max(xs)
    minz, maxz = min(zs), max(zs)
    w, h = box
    s = min((w - 2 * pad) / max(1e-9, maxx - minx), (h - 2 * pad) / max(1e-9, maxz - minz))
    ox = (w - (maxx - minx) * s) / 2.0
    oy = (h - (maxz - minz) * s) / 2.0

    def m(x, z):
        return ox + (x - minx) * s, oy + (z - minz) * s

    parts = []
    seen = set()
    for a, b, c in faces:
        # The top and bottom caps project to the same XZ triangle with opposite
        # winding; keeping both would cancel under the nonzero fill rule.
        key = tuple(sorted((round(verts[i][0], 5), round(verts[i][2], 5)) for i in (a, b, c)))
        if key in seen:
            continue
        seen.add(key)

        pa, pb, pc = m(verts[a][0], verts[a][2]), m(verts[b][0], verts[b][2]), m(verts[c][0], verts[c][2])
        if pa == pb or pb == pc or pa == pc:
            continue
        parts.append(f"M{pa[0]:.2f} {pa[1]:.2f}L{pb[0]:.2f} {pb[1]:.2f}L{pc[0]:.2f} {pc[1]:.2f}Z")
    return " ".join(parts), (minx, maxx, minz, maxz)


def svg_doc(width, height, body):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">'
        f'<rect width="{width}" height="{height}" fill="#ffffff"/>'
        f"{body}</svg>"
    )


def text(x, y, value, size=13, weight=400, color="#222", anchor="start"):
    return (
        f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{color}" '
        f'text-anchor="{anchor}">{html.escape(str(value))}</text>'
    )


def panel_title(x, y, title, subtitle, color):
    out = text(x, y, title, 16, 700, color)
    if subtitle:
        out += text(x, y + 18, subtitle, 12, 400, "#666")
    return out


# --------------------------------------------------------------------------- #
# 2D shapes
# --------------------------------------------------------------------------- #


def two_d_geometry(shape):
    if shape == "filled":
        return {
            "mode": "filled",
            "pen": FILL_PEN,
            "head_size": FILL_HEAD_SIZE,
            "head_width": FILL_HEAD_WIDTH,
            "head_base": TAIL_2D,
            "min_stem": 0.0,
        }
    return {
        "mode": "stroked",
        "pen": PEN_2D,
        "head_size": HEAD_SIZE_2D,
        "head_width": HEAD_WIDTH_2D,
        "head_base": MIN_BARE_STEM + TAIL_2D,
        "min_stem": MIN_BARE_STEM,
    }


def draw_2d_shape(shape, box, pad=22):
    """Draw one 2D shape into a box; returns (svg, total length)."""
    g = two_d_geometry(shape)
    w, h = box
    thick = g["pen"] / 2.0
    half_head = g["head_width"] / 2.0
    head_base = g["head_base"]
    tip = head_base + g["head_size"]

    max_x = max(half_head, thick) + 0.4
    min_y, max_y = -0.4, tip + 0.4
    s = min((w - 2 * pad) / (2 * max_x), (h - 2 * pad) / (max_y - min_y))
    cx = w / 2.0
    oy = (h - (max_y - min_y) * s) / 2.0

    def m(x, y):
        return cx + x * s, oy + (max_y - y) * s

    color = COLORS[shape]
    out = []

    if g["mode"] == "filled":
        pts = [
            (thick, 0.0),
            (thick, head_base),
            (half_head, head_base),
            (0.0, tip),
            (-half_head, head_base),
            (-thick, head_base),
            (-thick, 0.0),
        ]
        path = "M" + "L".join(f"{m(x, y)[0]:.2f} {m(x, y)[1]:.2f}" for x, y in pts) + "Z"
        out.append(f'<path d="{path}" fill="{color}" stroke="{color}" stroke-width="1"/>')
    else:
        # Stem and arms share one pen. Round-cap uses round caps; the flat
        # shapes use butt caps and a miter wedge at the apex (schematic).
        cap = "round" if shape == "round-cap" else "butt"
        sw = 2 * thick * s
        x0, y0 = m(0.0, thick if shape == "round-cap" else 0.0)
        x1, y1 = m(0.0, head_base)
        out.append(
            f'<line x1="{x0:.2f}" y1="{y0:.2f}" x2="{x1:.2f}" y2="{y1:.2f}" '
            f'stroke="{color}" stroke-width="{sw:.2f}" stroke-linecap="{cap}"/>'
        )
        arm_svg = []
        for sign in (-1, 1):
            ax, ay = m(sign * half_head, head_base - g["head_size"])
            arm_svg.append(
                f'<line x1="{x1:.2f}" y1="{y1:.2f}" x2="{ax:.2f}" y2="{ay:.2f}" '
                f'stroke="{color}" stroke-width="{sw:.2f}" stroke-linecap="{cap}"/>'
            )
        if shape == "vertical-cut":
            # The shader cuts the free ends parallel to the arrow axis. Clip the
            # butt-capped arms at x = +-headHalfWidth to show that vertical cut.
            clip_id = "clip-vertical-cut"
            cx0, _ = m(-half_head, 0.0)
            cx1, _ = m(half_head, 0.0)
            out.append(
                f'<defs><clipPath id="{clip_id}" clipPathUnits="userSpaceOnUse">'
                f'<rect x="{cx0:.2f}" y="0" width="{cx1 - cx0:.2f}" height="{h}"/>'
                f'</clipPath></defs>'
            )
            out.append(f'<g clip-path="url(#{clip_id})">{"".join(arm_svg)}</g>')
        else:
            out.extend(arm_svg)

        if shape != "round-cap":
            # The shader's flat shapes still have a round capsule cap at the
            # shared apex; draw it so the miter wedge joins without a notch.
            ax, ay = m(0.0, head_base)
            out.append(f'<circle cx="{ax:.2f}" cy="{ay:.2f}" r="{thick * s:.2f}" fill="{color}"/>')

            # Schematic miter wedge: the outer arm edges extended to a point.
            arm_len = math.hypot(half_head, g["head_size"])
            miter_extend = thick * arm_len / half_head
            shoulder_y = head_base + half_head * thick / arm_len
            tip_y = head_base + miter_extend
            wedge = [
                (0.0, tip_y),
                (0.0, shoulder_y),
                (g["head_size"] * thick / arm_len, shoulder_y),
            ]
            path = "M" + "L".join(f"{m(x, y)[0]:.2f} {m(x, y)[1]:.2f}" for x, y in wedge) + "Z"
            out.append(f'<path d="{path}" fill="{color}" stroke="{color}" stroke-width="1"/>')
            wedge = [(x * -1, y) for x, y in wedge]
            path = "M" + "L".join(f"{m(x, y)[0]:.2f} {m(x, y)[1]:.2f}" for x, y in wedge) + "Z"
            out.append(f'<path d="{path}" fill="{color}" stroke="{color}" stroke-width="1"/>')

    # A subtle centerline to show the anchor/tail.
    xa, ya = m(0.0, 0.0)
    xb, yb = m(0.0, tip)
    out.append(f'<line x1="{xa:.2f}" y1="{ya:.2f}" x2="{xb:.2f}" y2="{yb:.2f}" stroke="#999" stroke-width="0.6" stroke-dasharray="3 3" opacity="0.5"/>')
    return "".join(out), tip


def make_2d_previews(out_dir: Path):
    width, height = 1180, 500
    body = [text(24, 34, "2D arrow shapes — DynamicArrowLayer", 20, 700, "#222")]
    body.append(text(24, 56, "First four Tabqa presets. The no-border variant is a styling option, not a fifth shape.", 12, 400, "#666"))

    panel_w = (width - 40) / 4.0
    for i, shape in enumerate(STYLES):
        x = 20 + i * panel_w
        y = 78
        box = (panel_w - 16, 330)
        body.append(f'<rect x="{x:.1f}" y="{y}" width="{panel_w - 12:.1f}" height="390" rx="8" fill="#fafafa" stroke="#e5e5e5"/>')
        body.append(panel_title(x + 14, y + 26, LABELS[shape], "", COLORS[shape]))
        g = two_d_geometry(shape)
        sub = "filled stem + head" if shape == "filled" else "stroked open-V · one pen"
        body.append(text(x + 14, y + 46, sub, 12, 400, "#666"))
        svg, tip = draw_2d_shape(shape, box)
        body.append(f'<g transform="translate({x + 8:.1f},{y + 60})">{svg}</g>')
        body.append(text(x + 14, y + 366, f"tail {TAIL_2D:g} m", 11, 400, "#555"))
        if shape == "filled":
            body.append(text(x + 14, y + 382, f"head {FILL_HEAD_SIZE:g} m · pen {FILL_PEN:g} m", 11, 400, "#555"))
        else:
            body.append(text(x + 14, y + 382, f"head {HEAD_SIZE_2D:g} m · pen {PEN_2D:g} m", 11, 400, "#555"))
            body.append(text(x + 14, y + 398, f"+ {MIN_BARE_STEM:.2f} m shader min stem", 10, 400, "#888"))

    body.append(text(24, 490, "Schematic preview for documentation; the live gallery row is rendered by the shader.", 11, 400, "#888"))
    (out_dir / "arrow_2d_shapes.svg").write_text(svg_doc(width, height, "".join(body)), encoding="utf-8")


# --------------------------------------------------------------------------- #
# 3D previews
# --------------------------------------------------------------------------- #


def draw_obj_in_box(path: Path, box, color, pad=12):
    verts, faces = read_obj(path)
    d, bbox = triangles_path(verts, faces, box, pad)
    return f'<path d="{d}" fill="{color}" fill-opacity="0.9"/>', bbox


def make_3d_style_preview(preview_dir: Path, meshes_dir: Path, style: str, manifest: dict):
    width, height = 1240, 430
    color = COLORS[style]
    files = manifest["files"]
    head_name = f"arrow_head_{style.replace('-', '_')}.obj"
    single_name = f"arrow_single_{style.replace('-', '_')}.obj"
    metrics = manifest["styles"][style]
    body = [text(24, 34, f"3D arrow — {LABELS[style]}", 20, 700, "#222")]
    rear_note = "capped round tail, tail 4.5" if style == "round-cap" else "flat rear, tail 4.0"
    body.append(
        text(
            24,
            56,
            f"Split head (socket at Z=0) · shared tail parts · single mesh ({rear_note})",
            12,
            400,
            "#666",
        )
    )

    body.append(f'<rect x="20" y="76" width="300" height="300" rx="8" fill="#fafafa" stroke="#e5e5e5"/>')
    body.append(f'<rect x="336" y="76" width="300" height="300" rx="8" fill="#fafafa" stroke="#e5e5e5"/>')
    body.append(f'<rect x="652" y="76" width="340" height="300" rx="8" fill="#fafafa" stroke="#e5e5e5"/>')
    body.append(f'<rect x="1008" y="76" width="212" height="300" rx="8" fill="#fafafa" stroke="#e5e5e5"/>')

    body.append(panel_title(36, 102, "Split head", "sharp finish", color))
    head_svg, _ = draw_obj_in_box(meshes_dir / head_name, (276, 230), color)
    body.append(f'<g transform="translate(32,120)">{head_svg}</g>')

    body.append(panel_title(352, 102, "Tail parts", "stem + round cap", color))
    # The stem is a simple rod; a schematic rectangle reads better than its
    # projected side-wall triangles. The cap is projected from the OBJ.
    stem_rect = f'<rect x="12" y="62" width="96" height="96" rx="7" fill="{color}" fill-opacity="0.9"/>'
    cap_svg, _ = draw_obj_in_box(meshes_dir / "arrow_tail_round_end_rounded.obj", (120, 220), color)
    body.append(f'<g transform="translate(348,130)">{stem_rect}</g>')
    body.append(f'<g transform="translate(486,130)">{cap_svg}</g>')
    body.append(text(362, 360, "stem (1.0 unit)", 10, 400, "#777"))
    body.append(text(500, 360, "cap (0.5 deep)", 10, 400, "#777"))

    single_note = "sharp finish · capped round tail" if style == "round-cap" else "sharp finish · flat rear"
    body.append(panel_title(668, 102, "Single mesh", single_note, color))
    single_svg, _ = draw_obj_in_box(meshes_dir / single_name, (316, 230), color)
    body.append(f'<g transform="translate(664,120)">{single_svg}</g>')

    body.append(panel_title(1024, 102, "Dimensions", "model units", "#333"))
    lines = [
        "tail 4.5 (capped)" if style == "round-cap" else "tail 4.0",
        f"head span {metrics['span']:.3f}",
        f"socket→apex {metrics['socket_to_apex']:.3f}",
        f"overhang {metrics['overhang']:.3f}",
        f"single total {metrics['single_total']:.3f}",
        f"pen 1.0 · thickness 0.8",
    ]
    for i, line in enumerate(lines):
        body.append(text(1024, 132 + i * 20, line, 11, 400, "#555"))
    body.append(text(1024, 282, "sharp + beveled", 10, 400, "#888"))
    body.append(text(1024, 298, "variants generated", 10, 400, "#888"))

    body.append(text(24, 408, "Built by scripts/arrows/generate_arrows.py · sharp silhouette shown; beveled rims are in the OBJ set.", 11, 400, "#888"))
    (preview_dir / f"arrow_3d_{style.replace('-', '_')}.svg").write_text(svg_doc(width, height, "".join(body)), encoding="utf-8")


def make_3d_overview(preview_dir: Path, meshes_dir: Path, manifest: dict):
    width, height = 1180, 900
    body = [text(24, 34, "3D arrow meshes — four styles", 20, 700, "#222")]
    body.append(
        text(
            24,
            56,
            "Split head (socket origin) and single mesh (flat rear except the round-cap tail cap), projected from the OBJ triangles.",
            12,
            400,
            "#666",
        )
    )

    row_h = 200
    top = 82
    for i, style in enumerate(STYLES):
        y = top + i * row_h
        color = COLORS[style]
        body.append(f'<rect x="20" y="{y}" width="1140" height="{row_h - 14}" rx="8" fill="#fafafa" stroke="#e5e5e5"/>')
        body.append(panel_title(36, y + 28, LABELS[style], "", color))

        head_svg, _ = draw_obj_in_box(meshes_dir / f"arrow_head_{style.replace('-', '_')}.obj", (220, 140), color)
        body.append(f'<g transform="translate(36,{y + 40})">{head_svg}</g>')
        body.append(text(40, y + 184, "split head", 10, 400, "#777"))

        single_svg, _ = draw_obj_in_box(meshes_dir / f"arrow_single_{style.replace('-', '_')}.obj", (360, 140), color)
        body.append(f'<g transform="translate(280,{y + 40})">{single_svg}</g>')
        body.append(text(284, y + 184, "single", 10, 400, "#777"))

        m = manifest["styles"][style]
        body.append(text(680, y + 70, f"head span {m['span']:.3f}", 12, 400, "#444"))
        body.append(text(680, y + 90, f"socket→apex {m['socket_to_apex']:.3f}", 12, 400, "#444"))
        body.append(text(680, y + 110, f"overhang {m['overhang']:.3f}", 12, 400, "#444"))
        body.append(text(680, y + 130, f"single total {m['single_total']:.3f}", 12, 400, "#444"))
        body.append(text(680, y + 150, "pen 1.0 · thickness 0.8", 11, 400, "#777"))

        tri_head = manifest["files"][f"arrow_head_{style.replace('-', '_')}.obj"]["tris"]
        tri_single = manifest["files"][f"arrow_single_{style.replace('-', '_')}.obj"]["tris"]
        body.append(text(980, y + 70, f"head {tri_head} tris", 11, 400, "#666"))
        body.append(text(980, y + 90, f"single {tri_single} tris", 11, 400, "#666"))

    (preview_dir / "arrow_3d_overview.svg").write_text(svg_doc(width, height, "".join(body)), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate arrow documentation previews.")
    parser.add_argument(
        "--meshes",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "src" / "maps" / "ArrowGallery" / "meshes",
        help="Generated mesh directory.",
    )
    parser.add_argument("--out", type=Path, default=Path("/tmp/arrow-previews"), help="Preview output directory.")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((args.meshes / "manifest.json").read_text(encoding="utf-8"))

    make_2d_previews(args.out)
    make_3d_overview(args.out, args.meshes, manifest)
    for style in STYLES:
        make_3d_style_preview(args.out, args.meshes, style, manifest)

    print(f"Wrote previews to {args.out}")
    for path in sorted(args.out.glob("*.svg")):
        print(f"  {path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
