#!/usr/bin/env python3
"""
Documentation previews for the arrow pages.

Outputs (SVG, documentation aid only):
  arrow_2d_shapes.svg       four 2D shader shapes
  arrow_2d_<style>.svg      per-style 2D card
  arrow_3d_overview.svg     four 3D styles: axonometric head + single, front, side
  arrow_3d_<style>.svg      per-style split head / single / front / side
  arrow_3d_<style>_card.svg per-style 3D card (isometric + front + side)

The 2D shapes are drawn from the same 40 deg / 2.24 x pen formulas as the
DynamicArrowLayer shader; they are schematic, not a shader reimplementation.
The 3D previews are shaded axonometric and orthographic views of the generated
OBJ triangles (X width, Y thickness, Z length).
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
FILL_HEAD_SIZE = 5.25
FILL_HEAD_WIDTH = FILL_HEAD_SIZE
FILL_PEN = PEN_2D
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


# --------------------------------------------------------------------------- #
# Small vector helpers for the shaded 3D previews
# --------------------------------------------------------------------------- #

YAW = math.radians(24.0)
PITCH = math.radians(32.0)
LIGHT_A = (-0.40, 0.90, -0.35)
LIGHT_B = (0.75, 0.15, 0.65)


def hex_rgb(value: str):
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def shade(value: str, factor: float) -> str:
    r, g, b = hex_rgb(value)
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(c * factor))) for c in (r, g, b))


def unit(v):
    mag = math.sqrt(sum(c * c for c in v)) or 1.0
    return tuple(c / mag for c in v)


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


LIGHT_A = unit(LIGHT_A)
LIGHT_B = unit(LIGHT_B)


def view_point(x, y, z, view):
    """Return (screen_x, screen_y, depth); screen y is SVG-down, depth toward camera."""
    if view == "iso":
        cy, sy = math.cos(YAW), math.sin(YAW)
        cp, sp = math.cos(PITCH), math.sin(PITCH)
        x1 = x * cy - z * sy
        z1 = x * sy + z * cy
        return x1, z1 * cp - y * sp, z1 * sp + y * cp
    if view == "front":
        return x, z, y
    if view == "side":
        return z, y, x
    raise ValueError(f"unknown view: {view}")


def draw_obj_3d(path: Path, box, color: str, view: str = "iso", pad: int = 12):
    """Shaded projection of an OBJ; returns the SVG body."""
    verts, faces = read_obj(path)
    if not faces:
        return ""
    w, h = box
    projected = [view_point(x, y, z, view) for x, y, z in verts]
    us = [p[0] for p in projected]
    vs = [p[1] for p in projected]
    minu, maxu = min(us), max(us)
    minv, maxv = min(vs), max(vs)
    s = min((w - 2 * pad) / max(1e-9, maxu - minu), (h - 2 * pad) / max(1e-9, maxv - minv))
    ox = (w - (maxu - minu) * s) / 2.0 - minu * s
    oy = (h - (maxv - minv) * s) / 2.0 - minv * s
    pts = [(ox + u * s, oy + v * s) for u, v, _ in projected]

    def face_color(a, b, c):
        n = unit(cross(sub(b, a), sub(c, a)))
        k = 0.48 + 0.46 * abs(dot(n, LIGHT_A)) + 0.14 * abs(dot(n, LIGHT_B))
        return shade(color, min(1.0, k))

    order = sorted(range(len(faces)), key=lambda i: sum(projected[j][2] for j in faces[i]) / 3.0)
    out = []
    for i in order:
        a, b, c = faces[i]
        fill = face_color(verts[a], verts[b], verts[c])
        out.append(
            '<polygon points="%s" fill="%s" stroke="%s" stroke-width="0.8" stroke-linejoin="round"/>'
            % (
                " ".join(f"{pts[j][0]:.2f},{pts[j][1]:.2f}" for j in (a, b, c)),
                fill,
                fill,
            )
        )

    # Boundary edges only: a clean silhouette without triangulation lines.
    counts = {}
    for a, b, c in faces:
        for e in ((a, b), (b, c), (c, a)):
            k = tuple(sorted(e))
            counts[k] = counts.get(k, 0) + 1
    stroke = shade(color, 0.72)
    for (a, b), n in counts.items():
        if n == 1:
            out.append(
                '<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f" stroke="%s" stroke-width="1.1"/>'
                % (pts[a][0], pts[a][1], pts[b][0], pts[b][1], stroke)
            )
    return "".join(out)


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


def draw_2d_shape(shape, box, pad=22, centerline=True):
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

    if centerline:
        # A subtle centerline to show the anchor/tail.
        xa, ya = m(0.0, 0.0)
        xb, yb = m(0.0, tip)
        out.append(f'<line x1="{xa:.2f}" y1="{ya:.2f}" x2="{xb:.2f}" y2="{yb:.2f}" stroke="#999" stroke-width="0.6" stroke-dasharray="3 3" opacity="0.5"/>')
    return "".join(out), tip


def make_2d_previews(out_dir: Path):
    width, height = 1180, 500
    body = [text(24, 34, "2D arrow shapes — DynamicArrowLayer", 20, 700, "#222")]
    body.append(text(24, 56, "Filled follows the compo-EW equilateral footprint; the stroked shapes show the Tabqa presets. The no-border variant is a styling option, not a fifth shape.", 12, 400, "#666"))

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


def make_2d_card(out_dir: Path, style: str):
    """Compact per-style 2D card used as the registry 2D Preview."""
    width, height = 800, 600
    color = COLORS[style]
    shape_id = "fill-head" if style == "filled" else style
    body = [
        text(28, 44, f"{LABELS[style]} — 2D", 22, 700, "#222"),
        text(28, 70, f"DynamicArrowLayer · shape {shape_id}", 13, 400, "#666"),
        f'<rect x="20" y="88" width="760" height="436" rx="10" fill="#fafafa" stroke="#e5e5e5"/>',
    ]
    svg, _ = draw_2d_shape(style, (720, 400), pad=18)
    body.append(f'<g transform="translate(40,106)">{svg}</g>')

    g = two_d_geometry(style)
    body.append(text(28, 556, f"tail {TAIL_2D:g} m · pen {g['pen']:g} m · head {g['head_size']:g} m", 12, 400, "#555"))
    if style == "filled":
        body.append(text(28, 578, "data head 6.5–13 m from coh · width 0.8 × head · no shader reserve", 11, 400, "#888"))
    else:
        body.append(text(28, 578, f"+ {MIN_BARE_STEM:.2f} m shader-side minimum bare stem", 11, 400, "#888"))
    body.append(text(772, 578, "schematic; the shader draws row 1", 10, 400, "#aaa", "end"))
    (out_dir / f"arrow_2d_{style.replace('-', '_')}.svg").write_text(svg_doc(width, height, "".join(body)), encoding="utf-8")


def make_2d_thumb(out_dir: Path, style: str):
    """Arrow-only 2D thumbnail for the registry preview properties."""
    size = 600
    svg, _ = draw_2d_shape(style, (size - 48, size - 48), pad=10, centerline=False)
    body = f'<g transform="translate(24,24)">{svg}</g>'
    (out_dir / f"arrow_2d_{style.replace('-', '_')}_thumb.svg").write_text(svg_doc(size, size, body), encoding="utf-8")


# --------------------------------------------------------------------------- #
# 3D previews
# --------------------------------------------------------------------------- #


def make_3d_style_preview(preview_dir: Path, meshes_dir: Path, shared_meshes_dir: Path, style: str, manifest: dict):
    width, height = 1240, 520
    color = COLORS[style]
    metrics = manifest["styles"][style]
    head_path = meshes_dir / f"arrow_head_{style.replace('-', '_')}.obj"
    single_path = meshes_dir / f"arrow_single_{style.replace('-', '_')}.obj"
    rear_note = "capped round tail" if style == "round-cap" else "flat rear"

    body = [text(24, 34, f"3D arrow — {LABELS[style]}", 20, 700, "#222")]
    body.append(
        text(
            24,
            58,
            "Shaded isometric views; front (XZ) and side (YZ) orthographic cross-checks of the single mesh.",
            12,
            400,
            "#666",
        )
    )

    for x, w in ((20, 378), (414, 378)):
        body.append(f'<rect x="{x}" y="78" width="{w}" height="414" rx="10" fill="#fafafa" stroke="#e5e5e5"/>')
    body.append('<rect x="808" y="78" width="224" height="196" rx="10" fill="#fafafa" stroke="#e5e5e5"/>')
    body.append('<rect x="1040" y="78" width="180" height="196" rx="10" fill="#fafafa" stroke="#e5e5e5"/>')
    body.append('<rect x="808" y="286" width="412" height="206" rx="10" fill="#fafafa" stroke="#e5e5e5"/>')

    body.append(panel_title(36, 104, "Split head", "isometric · sharp finish", color))
    body.append(f'<g transform="translate(40,132)">{draw_obj_3d(head_path, (338, 330), color, "iso")}</g>')
    body.append(text(36, 478, "socket at Z = 0 · 40° footprint", 10, 400, "#777"))

    body.append(panel_title(430, 104, "Single mesh", f"isometric · sharp · {rear_note}", color))
    body.append(f'<g transform="translate(434,132)">{draw_obj_3d(single_path, (338, 330), color, "iso")}</g>')
    body.append(text(430, 478, f"single total {metrics['single_total']:.3f}", 10, 400, "#777"))

    body.append(panel_title(824, 104, "Front (XZ)", "face view", color))
    body.append(f'<g transform="translate(824,132)">{draw_obj_3d(single_path, (192, 130), color, "front")}</g>')
    body.append(text(824, 268, "span and overhang", 10, 400, "#777"))

    body.append(panel_title(1056, 104, "Side (YZ)", "thickness", color))
    body.append(f'<g transform="translate(1056,132)">{draw_obj_3d(single_path, (148, 130), color, "side")}</g>')
    body.append(text(1056, 268, "pen 1.0 · 0.8 thick", 10, 400, "#777"))

    body.append(panel_title(824, 312, "Dimensions", "model units", "#333"))
    lines = [
        "tail 4.5 (capped)" if style == "round-cap" else "tail 4.0",
        f"head span {metrics['span']:.3f}",
        f"socket→apex {metrics['socket_to_apex']:.3f}",
        f"overhang {metrics['overhang']:.3f}",
        f"single total {metrics['single_total']:.3f}",
        "pen 1.0 · thickness 0.8",
    ]
    for i, line in enumerate(lines):
        body.append(text(824, 340 + i * 20, line, 11, 400, "#555"))
    body.append(text(824, 468, "sharp + beveled variants generated", 10, 400, "#888"))

    body.append(
        text(
            24,
            512,
            "Shaded from the OBJ triangles · beveled geometry is in the OBJ set, silhouettes shown sharp.",
            11,
            400,
            "#888",
        )
    )
    (preview_dir / f"arrow_3d_{style.replace('-', '_')}.svg").write_text(svg_doc(width, height, "".join(body)), encoding="utf-8")


def make_3d_card(preview_dir: Path, meshes_dir: Path, style: str, manifest: dict):
    """Compact per-style 3D card used as the registry 3D Preview."""
    width, height = 800, 600
    color = COLORS[style]
    metrics = manifest["styles"][style]
    single_path = meshes_dir / f"arrow_single_{style.replace('-', '_')}.obj"
    rear_note = "capped round tail" if style == "round-cap" else "flat rear"

    body = [
        text(28, 44, f"{LABELS[style]} — 3D", 22, 700, "#222"),
        text(28, 70, f"Single mesh · sharp finish · {rear_note}", 13, 400, "#666"),
        '<rect x="20" y="88" width="500" height="436" rx="10" fill="#fafafa" stroke="#e5e5e5"/>',
        '<rect x="532" y="88" width="248" height="208" rx="10" fill="#fafafa" stroke="#e5e5e5"/>',
        '<rect x="532" y="316" width="248" height="208" rx="10" fill="#fafafa" stroke="#e5e5e5"/>',
    ]

    body.append(text(36, 112, "Isometric", 13, 700, color))
    body.append(f'<g transform="translate(40,124)">{draw_obj_3d(single_path, (460, 380), color, "iso")}</g>')

    body.append(text(548, 112, "Front (XZ)", 12, 700, color))
    body.append(f'<g transform="translate(548,124)">{draw_obj_3d(single_path, (216, 150), color, "front")}</g>')

    body.append(text(548, 340, "Side (YZ)", 12, 700, color))
    body.append(f'<g transform="translate(548,352)">{draw_obj_3d(single_path, (216, 150), color, "side")}</g>')

    body.append(text(28, 556, f"total {metrics['single_total']:.3f} · span {metrics['span']:.3f} · overhang {metrics['overhang']:.3f}", 12, 400, "#555"))
    body.append(text(28, 578, "pen 1.0 · thickness 0.8 · socket→apex " + f"{metrics['socket_to_apex']:.3f}", 11, 400, "#888"))
    body.append(text(772, 578, "shaded OBJ · sharp silhouette", 10, 400, "#aaa", "end"))
    (preview_dir / f"arrow_3d_{style.replace('-', '_')}_card.svg").write_text(svg_doc(width, height, "".join(body)), encoding="utf-8")


def make_3d_thumb(preview_dir: Path, meshes_dir: Path, style: str):
    """Arrow-only 3D thumbnail for the registry preview properties."""
    size = 600
    color = COLORS[style]
    single_path = meshes_dir / f"arrow_single_{style.replace('-', '_')}.obj"
    body = f'<g transform="translate(24,24)">{draw_obj_3d(single_path, (size - 48, size - 48), color, "iso")}</g>'
    (preview_dir / f"arrow_3d_{style.replace('-', '_')}_thumb.svg").write_text(svg_doc(size, size, body), encoding="utf-8")


def make_3d_overview(preview_dir: Path, meshes_dir: Path, manifest: dict):
    width, height = 1180, 900
    body = [text(24, 34, "3D arrow meshes — four styles", 20, 700, "#222")]
    body.append(
        text(
            24,
            58,
            "Shaded isometric head and single, with front (XZ) and side (YZ) orthographic views of the single.",
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
        body.append(f'<rect x="20" y="{y}" width="1140" height="{row_h - 14}" rx="10" fill="#fafafa" stroke="#e5e5e5"/>')
        body.append(panel_title(36, y + 28, LABELS[style], "", color))

        head_path = meshes_dir / f"arrow_head_{style.replace('-', '_')}.obj"
        single_path = meshes_dir / f"arrow_single_{style.replace('-', '_')}.obj"

        body.append(f'<g transform="translate(36,{y + 40})">{draw_obj_3d(head_path, (170, 132), color, "iso")}</g>')
        body.append(text(40, y + 182, "split head · iso", 10, 400, "#777"))

        body.append(f'<g transform="translate(220,{y + 40})">{draw_obj_3d(single_path, (280, 132), color, "iso")}</g>')
        body.append(text(224, y + 182, "single · iso", 10, 400, "#777"))

        body.append(f'<g transform="translate(510,{y + 40})">{draw_obj_3d(single_path, (130, 132), color, "front")}</g>')
        body.append(text(514, y + 182, "front (XZ)", 10, 400, "#777"))

        body.append(f'<g transform="translate(650,{y + 40})">{draw_obj_3d(single_path, (90, 132), color, "side")}</g>')
        body.append(text(654, y + 182, "side (YZ)", 10, 400, "#777"))

        m = manifest["styles"][style]
        body.append(text(760, y + 66, f"head span {m['span']:.3f}", 12, 400, "#444"))
        body.append(text(760, y + 86, f"socket→apex {m['socket_to_apex']:.3f}", 12, 400, "#444"))
        body.append(text(760, y + 106, f"overhang {m['overhang']:.3f}", 12, 400, "#444"))
        body.append(text(760, y + 126, f"single total {m['single_total']:.3f}", 12, 400, "#444"))
        body.append(text(760, y + 146, "pen 1.0 · thickness 0.8", 11, 400, "#777"))

        tri_head = manifest["files"][head_path.name]["tris"]
        tri_single = manifest["files"][single_path.name]["tris"]
        body.append(text(1010, y + 66, f"head {tri_head} tris", 11, 400, "#666"))
        body.append(text(1010, y + 86, f"single {tri_single} tris", 11, 400, "#666"))

    (preview_dir / "arrow_3d_overview.svg").write_text(svg_doc(width, height, "".join(body)), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate arrow documentation previews.")
    parser.add_argument(
        "--meshes",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "src" / "maps" / "ArrowGallery" / "meshes",
        help="Generated mesh directory.",
    )
    parser.add_argument(
        "--shared-meshes",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "src" / "layers" / "velocity" / "meshes",
        help="Shared tail mesh directory.",
    )
    parser.add_argument("--out", type=Path, default=Path("/tmp/arrow-previews"), help="Preview output directory.")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((args.meshes / "manifest.json").read_text(encoding="utf-8"))

    make_2d_previews(args.out)
    for style in STYLES:
        make_2d_card(args.out, style)
        make_2d_thumb(args.out, style)
    make_3d_overview(args.out, args.meshes, manifest)
    for style in STYLES:
        make_3d_style_preview(args.out, args.meshes, args.shared_meshes, style, manifest)
        make_3d_card(args.out, args.meshes, style, manifest)
        make_3d_thumb(args.out, args.meshes, style)

    print(f"Wrote previews to {args.out}")
    for path in sorted(args.out.glob("*.svg")):
        print(f"  {path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
