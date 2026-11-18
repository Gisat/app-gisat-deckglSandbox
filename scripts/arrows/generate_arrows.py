#!/usr/bin/env python3
"""
Generate the 2D/3D arrow documentation assets.

Outputs:
  - split 3D heads (sharp + beveled) for filled / round-cap / square-cap / vertical-cut
  - shared tail parts: sharp stem, rounded-edge stem, beveled-edge stem (sharp
    end faces), selectively beveled round cap
  - single-mesh arrows (sharp + beveled), canonical tail 4.0, flat rear
    except the round-cap single, whose tail keeps the round cap
  - manifest.json with counts, bounding boxes and hashes

The meshes use the documentation convention:
  origin at the part base / stem socket
  long axis -Z (forward), width X, thickness Y
  pen width 1.0 (X +-0.5), thickness 0.8 (Y +-0.4)

The four head profiles are derived from the same 40 deg / 2.24 x pen footprint
used by the 2D DynamicArrowLayer shader. The 3D heads are solid extrusions; the
2D shapes are stroked / filled in the shader.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from pathlib import Path

# --------------------------------------------------------------------------- #
# Shared model constants
# --------------------------------------------------------------------------- #

PEN_WIDTH = 1.0
HALF_PEN = PEN_WIDTH / 2.0
THICKNESS = 0.8
HALF_THICKNESS = THICKNESS / 2.0
BEVEL_SIZE = 0.08
BEVEL_STEPS = 3
# Short fade at a connection seam: the bevel runs at full width up to this
# distance from the socket edge, then stops (reads as a cut, not a taper).
SOCKET_TAPER = 0.1

TAIL_LENGTH = 4.0
HEAD_ANGLE_DEG = 40.0
# 2.24 is the along-axis head size (matching `2.24 x pen` in the 2D shader),
# not the wing-arm hypotenuse.
HEAD_SIZE_RATIO = 2.24
HEAD_REFERENCE_PEN = 1.5
NUM_ARC = 8

# 2D shader reference values (kept here so the 3D heads match the same footprint).
THETA = math.radians(HEAD_ANGLE_DEG)
SIN_T = math.sin(THETA)
COS_T = math.cos(THETA)
TAN_T = math.tan(THETA)
HEAD_SIZE = HEAD_SIZE_RATIO * PEN_WIDTH
HEAD_HALF_WIDTH = HEAD_SIZE * TAN_T
ARM_LENGTH = HEAD_SIZE / COS_T

L_STEM = 4.0
WING_BACK = HEAD_SIZE + HALF_PEN
MIN_STEM = 1.0 * PEN_WIDTH + WING_BACK
TOTAL_STEM = MIN_STEM + L_STEM
HEAD_BASE_Y = TOTAL_STEM
MITER_EXTEND = HALF_PEN / SIN_T
APEX_TIP_Y = HEAD_BASE_Y + MITER_EXTEND
T_INNER = HALF_PEN * (1.0 + COS_T) / SIN_T
Y_INNER = HEAD_BASE_Y - HALF_PEN * SIN_T - T_INNER * COS_T

STYLES = ("filled", "round-cap", "square-cap", "vertical-cut")
STYLE_LABELS = {
    "filled": "Filled",
    "round-cap": "Round-cap",
    "square-cap": "Square-cap",
    "vertical-cut": "Vertical-cut",
}

# --------------------------------------------------------------------------- #
# 2D helpers (ear clipping / winding / normals)
# --------------------------------------------------------------------------- #


def point_in_triangle(p, a, b, c) -> bool:
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])

    d1 = sign(p, a, b)
    d2 = sign(p, b, c)
    d3 = sign(p, c, a)
    has_neg = d1 < -1e-7 or d2 < -1e-7 or d3 < -1e-7
    has_pos = d1 > 1e-7 or d2 > 1e-7 or d3 > 1e-7
    return not (has_neg and has_pos)


def is_clockwise(poly) -> bool:
    area = 0.0
    n = len(poly)
    for i in range(n):
        p1 = poly[i]
        p2 = poly[(i + 1) % n]
        area += (p2[0] - p1[0]) * (p2[1] + p1[1])
    return area > 0


def ensure_ccw(poly):
    return list(reversed(poly)) if is_clockwise(poly) else poly


def triangulate_polygon_2d(poly):
    n = len(poly)
    if n < 3:
        return []

    indices = list(range(n))
    if is_clockwise(poly):
        indices.reverse()

    triangles = []

    while len(indices) > 3:
        ear_found = False
        m = len(indices)
        for i in range(m):
            prev_idx = indices[(i - 1) % m]
            curr_idx = indices[i]
            next_idx = indices[(i + 1) % m]

            a, b, c = poly[prev_idx], poly[curr_idx], poly[next_idx]

            cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if cross <= 1e-9:
                continue

            is_ear = True
            for k in range(m):
                other_idx = indices[k]
                if other_idx in (prev_idx, curr_idx, next_idx):
                    continue
                if point_in_triangle(poly[other_idx], a, b, c):
                    is_ear = False
                    break

            if is_ear:
                triangles.append((prev_idx, curr_idx, next_idx))
                indices.pop(i)
                ear_found = True
                break

        if not ear_found:
            break

    if len(indices) == 3:
        triangles.append((indices[0], indices[1], indices[2]))

    return triangles


def compute_inward_normals_xz(poly):
    n = len(poly)
    normals = []
    for i in range(n):
        p_prev = poly[(i - 1) % n]
        p_curr = poly[i]
        p_next = poly[(i + 1) % n]

        v1 = (p_curr[0] - p_prev[0], p_curr[1] - p_prev[1])
        v2 = (p_next[0] - p_curr[0], p_next[1] - p_curr[1])

        len1 = math.hypot(*v1)
        len2 = math.hypot(*v2)
        if len1 < 1e-9 or len2 < 1e-9:
            normals.append((0.0, 0.0))
            continue

        u1 = (v1[0] / len1, v1[1] / len1)
        u2 = (v2[0] / len2, v2[1] / len2)

        n1 = (-u1[1], u1[0])
        n2 = (-u2[1], u2[0])

        nx = n1[0] + n2[0]
        nz = n1[1] + n2[1]
        n_len = math.hypot(nx, nz)

        if n_len < 1e-6:
            normals.append(n1)
        else:
            dot = (n1[0] * nx + n1[1] * nz) / n_len
            scale = 1.0 / max(0.1, dot)
            normals.append((scale * nx / n_len, scale * nz / n_len))

    return normals


def compute_selective_inward_normals_xz(poly):
    """Inward normals, with NZ forced to 0 on the flat Z = 0 seam."""
    normals = compute_inward_normals_xz(poly)
    out = []
    for (nx, nz), (_, z) in zip(normals, poly):
        if abs(z) < 1e-5:
            out.append((nx, 0.0))
        else:
            out.append((nx, nz))
    return out


# --------------------------------------------------------------------------- #
# OBJ writers
# --------------------------------------------------------------------------- #


def clean(value: float) -> float:
    """Normalize negative zero so manifests and OBJ text stay tidy."""
    return 0.0 if abs(value) < 1e-12 else value


def write_obj(path: Path, object_name: str, verts, faces, header: str) -> None:
    lines = [f"# {header}", f"o {object_name}"]
    lines.extend(f"v {clean(x):.6f} {clean(y):.6f} {clean(z):.6f}" for x, y, z in verts)
    lines.append("s 1")
    lines.extend("f " + " ".join(str(i) for i in face) for face in faces)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def export_sharp_extruded(
    path: Path,
    object_name: str,
    poly_xz,
    header: str,
    thickness: float = THICKNESS,
) -> tuple[list, list]:
    """Extrude a 2D XZ footprint into a sharp-edged prism with Y thickness."""
    poly = ensure_ccw(poly_xz)
    tris = triangulate_polygon_2d(poly)
    n = len(poly)
    half = thickness / 2.0

    verts = [(x, -half, z) for x, z in poly] + [(x, half, z) for x, z in poly]
    faces = []

    for i in range(n):
        j = (i + 1) % n
        v1, v2, v3, v4 = i + 1, j + 1, j + 1 + n, i + 1 + n
        faces.append((v1, v2, v3))
        faces.append((v1, v3, v4))

    for a, b, c in tris:
        faces.append((a + 1, c + 1, b + 1))  # bottom, facing -Y
    for a, b, c in tris:
        faces.append((a + 1 + n, b + 1 + n, c + 1 + n))  # top, facing +Y

    write_obj(path, object_name, verts, faces, header)
    return verts, faces


def drop_degenerate_faces(verts, faces, eps: float = 1e-12):
    """Remove zero-area faces (collapsed bevel rings) and unused vertices."""
    kept = []
    for a, b, c in faces:
        p0, p1, p2 = verts[a - 1], verts[b - 1], verts[c - 1]
        ab = (p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
        ac = (p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2])
        cx = ab[1] * ac[2] - ab[2] * ac[1]
        cy = ab[2] * ac[0] - ab[0] * ac[2]
        cz = ab[0] * ac[1] - ab[1] * ac[0]
        if math.sqrt(cx * cx + cy * cy + cz * cz) > eps:
            kept.append((a, b, c))

    used = sorted({index for face in kept for index in face})
    remap = {old: new for new, old in enumerate(used, start=1)}
    welded_verts = [verts[index - 1] for index in used]
    welded_faces = [tuple(remap[index] for index in face) for face in kept]

    # Weight-0 bevel columns leave coincident ring vertices behind. Weld them so
    # the sharp edge becomes a single shared edge instead of an open seam.
    key_to_index = {}
    weld_remap = {}
    final_verts = []
    for index, (x, y, z) in enumerate(welded_verts, start=1):
        key = (round(x, 6), round(y, 6), round(z, 6))
        if key not in key_to_index:
            key_to_index[key] = len(final_verts) + 1
            final_verts.append((x, y, z))
        weld_remap[index] = key_to_index[key]
    final_faces = [tuple(weld_remap[index] for index in face) for face in welded_faces]

    used_final = sorted({index for face in final_faces for index in face})
    compact = {old_index: new_index for new_index, old_index in enumerate(used_final, start=1)}
    return (
        [final_verts[index - 1] for index in used_final],
        [tuple(compact[index] for index in face) for face in final_faces],
    )


def export_beveled(
    path: Path,
    object_name: str,
    poly_xz,
    header: str,
    thickness: float = THICKNESS,
    bevel_size: float = BEVEL_SIZE,
    bevel_steps: int = BEVEL_STEPS,
    bevel_weights=None,
) -> tuple[list, list]:
    """Extrude a 2D XZ footprint with a smooth bevel on the top/bottom rims.

    `bevel_weights` optionally gives a per-vertex bevel amount in `[0, 1]`.
    Vertices at 0 keep their outline point on the top/bottom faces with a full
    height side wall, producing a sharp edge there instead of a bevel — used to
    keep connection seams (the head socket, the capped stem end) invisible.
    """
    poly_in = list(poly_xz)
    n_in = len(poly_in)
    weights = list(bevel_weights) if bevel_weights is not None else [1.0] * n_in
    if len(weights) != n_in:
        raise ValueError("bevel_weights must match the polygon length")

    if is_clockwise(poly_in):
        poly = list(reversed(poly_in))
        weights = list(reversed(weights))
    else:
        poly = poly_in

    normals = compute_inward_normals_xz(poly)
    n = len(poly)
    half = thickness / 2.0

    top_rings = []
    for k in range(bevel_steps + 1):
        angle = (math.pi / 2.0) * (k / float(bevel_steps))
        top_rings.append(
            [
                (
                    x + bevel_size * w * (1.0 - math.cos(angle)) * nx,
                    (half - bevel_size * w) + bevel_size * w * math.sin(angle),
                    z + bevel_size * w * (1.0 - math.cos(angle)) * nz,
                )
                for (x, z), (nx, nz), w in zip(poly, normals, weights)
            ]
        )

    bottom_rings = []
    for k in range(bevel_steps + 1):
        angle = (math.pi / 2.0) * (k / float(bevel_steps))
        bottom_rings.append(
            [
                (
                    x + bevel_size * w * (1.0 - math.cos(angle)) * nx,
                    -((half - bevel_size * w) + bevel_size * w * math.sin(angle)),
                    z + bevel_size * w * (1.0 - math.cos(angle)) * nz,
                )
                for (x, z), (nx, nz), w in zip(poly, normals, weights)
            ]
        )

    verts = []
    b_cap_start = len(verts) + 1
    verts.extend(bottom_rings[-1])

    b_ring_starts = []
    for k in range(bevel_steps - 1, -1, -1):
        b_ring_starts.append(len(verts) + 1)
        verts.extend(bottom_rings[k])

    t_ring_starts = []
    for k in range(bevel_steps):
        t_ring_starts.append(len(verts) + 1)
        verts.extend(top_rings[k])

    t_cap_start = len(verts) + 1
    verts.extend(top_rings[-1])

    faces = []

    prev = b_cap_start
    for start in b_ring_starts:
        for i in range(n):
            j = (i + 1) % n
            faces.append((prev + i, prev + j, start + j))
            faces.append((prev + i, start + j, start + i))
        prev = start

    wall_b = b_ring_starts[-1]
    wall_t = t_ring_starts[0]
    for i in range(n):
        j = (i + 1) % n
        faces.append((wall_b + i, wall_b + j, wall_t + j))
        faces.append((wall_b + i, wall_t + j, wall_t + i))

    prev = wall_t
    for start in t_ring_starts[1:]:
        for i in range(n):
            j = (i + 1) % n
            faces.append((prev + i, prev + j, start + j))
            faces.append((prev + i, start + j, start + i))
        prev = start

    for i in range(n):
        j = (i + 1) % n
        faces.append((prev + i, prev + j, t_cap_start + j))
        faces.append((prev + i, t_cap_start + j, t_cap_start + i))

    inset_poly = [(v[0], v[2]) for v in top_rings[-1]]
    tris = triangulate_polygon_2d(inset_poly)
    for a, b, c in tris:
        faces.append((b_cap_start + a, b_cap_start + c, b_cap_start + b))
    for a, b, c in tris:
        faces.append((t_cap_start + a, t_cap_start + b, t_cap_start + c))

    verts, faces = drop_degenerate_faces(verts, faces)
    write_obj(path, object_name, verts, faces, header)
    return verts, faces


# --------------------------------------------------------------------------- #
# Head profiles (socket at the local origin, apex toward -Z)
# --------------------------------------------------------------------------- #


def _head_poly_xy(style: str):
    """Head outline in authoring space (+y forward, socket at `socket_y`)."""
    if style == "filled":
        poly_xy = [
            (-HALF_PEN, 0.0),
            (HALF_PEN, 0.0),
            (1.75, 0.0),
            (0.0, 3.0),
            (-1.75, 0.0),
        ]
        return poly_xy, 0.0

    if style == "round-cap":
        poly_xy = [(-HALF_PEN, Y_INNER), (HALF_PEN, Y_INNER)]

        c_rx, c_ry = HEAD_HALF_WIDTH, HEAD_BASE_Y - HEAD_SIZE
        start_r = math.radians(220.0)
        for i in range(NUM_ARC + 1):
            ang = start_r + (math.pi * i / NUM_ARC)
            poly_xy.append((c_rx + HALF_PEN * math.cos(ang), c_ry + HALF_PEN * math.sin(ang)))

        start_a = math.radians(40.0)
        end_a = math.radians(140.0)
        for i in range(1, NUM_ARC):
            ang = start_a + ((end_a - start_a) * i / NUM_ARC)
            poly_xy.append((HALF_PEN * math.cos(ang), HEAD_BASE_Y + HALF_PEN * math.sin(ang)))

        c_lx, c_ly = -HEAD_HALF_WIDTH, HEAD_BASE_Y - HEAD_SIZE
        start_l = math.radians(140.0)
        for i in range(NUM_ARC + 1):
            ang = start_l + (math.pi * i / NUM_ARC)
            poly_xy.append((c_lx + HALF_PEN * math.cos(ang), c_ly + HALF_PEN * math.sin(ang)))

    elif style == "square-cap":
        cx, cy = HEAD_HALF_WIDTH, HEAD_BASE_Y - HEAD_SIZE
        rx_outer = cx + HALF_PEN * COS_T
        ry_outer = cy + HALF_PEN * SIN_T
        rx_inner = cx - HALF_PEN * COS_T
        ry_inner = cy - HALF_PEN * SIN_T
        poly_xy = [
            (-HALF_PEN, Y_INNER),
            (HALF_PEN, Y_INNER),
            (rx_inner, ry_inner),
            (rx_outer, ry_outer),
            (0.0, APEX_TIP_Y),
            (-rx_outer, ry_outer),
            (-rx_inner, ry_inner),
        ]

    elif style == "vertical-cut":
        t_outer = (HEAD_HALF_WIDTH - HALF_PEN * COS_T) / SIN_T
        y_outer = HEAD_BASE_Y + HALF_PEN * SIN_T - t_outer * COS_T
        t_inner = (HEAD_HALF_WIDTH + HALF_PEN * COS_T) / SIN_T
        y_inner = HEAD_BASE_Y - HALF_PEN * SIN_T - t_inner * COS_T
        poly_xy = [
            (-HALF_PEN, Y_INNER),
            (HALF_PEN, Y_INNER),
            (HEAD_HALF_WIDTH, y_inner),
            (HEAD_HALF_WIDTH, y_outer),
            (0.0, APEX_TIP_Y),
            (-HEAD_HALF_WIDTH, y_outer),
            (-HEAD_HALF_WIDTH, y_inner),
        ]

    else:
        raise ValueError(f"Unknown style: {style}")

    return poly_xy, Y_INNER


def _socket_taper(poly_xy):
    """Add short taper points next to the socket edge and their bevel weights.

    The socket edge (poly[0] to poly[1]) stays sharp (weight 0). Points one
    `SOCKET_TAPER` along the two adjacent edges get weight 1, so the bevel runs
    at full width until just before the connection and then stops instead of
    fading across the whole adjacent edge.
    """
    def toward(a, b, distance):
        vx, vy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(vx, vy)
        if length < 1e-9:
            return a
        d = min(distance, length * 0.45)
        return (a[0] + vx / length * d, a[1] + vy / length * d)

    before = toward(poly_xy[0], poly_xy[-1], SOCKET_TAPER)
    after = toward(poly_xy[1], poly_xy[2], SOCKET_TAPER)
    tapered = [before, poly_xy[0], poly_xy[1], after] + list(poly_xy[2:])
    weights = [1.0, 0.0, 0.0, 1.0] + [1.0] * (len(poly_xy) - 2)
    return tapered, weights


def head_profile_xz(style: str) -> list[tuple[float, float]]:
    """Return the head outline in XZ with the flat stem socket at Z = 0.

    The profile is authored in 2D (x, y) with +y toward the tip, the socket at
    y = 0 and the apex toward +y, then mapped to z = -y for the 3D convention.
    """
    poly_xy, socket_y = _head_poly_xy(style)
    return [(x, -(y - socket_y)) for x, y in poly_xy]


def head_bevel_profile_xz(style: str):
    """Beveled head outline plus per-vertex bevel weights.

    Identical footprint to `head_profile_xz` with two extra collinear taper
    points near the socket corners; see `_socket_taper`.
    """
    poly_xy, socket_y = _head_poly_xy(style)
    poly_xy, weights = _socket_taper(poly_xy)
    return [(x, -(y - socket_y)) for x, y in poly_xy], weights


def single_tail_extent(style: str, tail: float = TAIL_LENGTH) -> float:
    """Rear-most tail extent, including the round-cap tail dome.

    Every single keeps a straight stem of `tail`; the round-cap single also ends
    with the same semicircular cap the split round-cap composite uses, so its
    rear-most point sits one cap radius behind the straight stem.
    """
    return tail + (HALF_PEN if style == "round-cap" else 0.0)


def single_profile_xz(style: str, tail: float = TAIL_LENGTH) -> list[tuple[float, float]]:
    """Union of a stem (length `tail`) and the head, socket at the stem tip.

    The round-cap single replaces the flat rear edge with a semicircular cap
    (radius = half pen) matching the split row's round tail end, so the tail is
    always capped; the other styles keep the flat rear.
    """
    head = head_profile_xz(style)
    head_y = [(x, -z) for x, z in head]  # socket at 0, rear negative, apex positive

    if style == "round-cap":
        cap_r = HALF_PEN
        socket = tail + cap_r
        # Semicircle from (-cap_r, cap_r) through (0, 0) to (cap_r, cap_r): the
        # dome bulges rearward, the straight stem starts one radius forward.
        poly_xy = []
        for i in range(NUM_ARC + 1):
            ang = math.pi + math.pi * i / NUM_ARC
            poly_xy.append((cap_r * math.cos(ang), cap_r + cap_r * math.sin(ang)))
    else:
        socket = tail
        poly_xy = [(-HALF_PEN, 0.0), (HALF_PEN, 0.0)]

    shifted = [(x, y + socket) for x, y in head_y]
    poly_xy.append((HALF_PEN, socket))
    poly_xy.extend(shifted[2:])
    poly_xy.append((-HALF_PEN, socket))
    return [(x, -y) for x, y in poly_xy]


def head_metrics(style: str) -> tuple[float, float, float]:
    """Return (bbox span, socket->apex, overhang) in model units."""
    profile = head_profile_xz(style)
    zs = [z for _, z in profile]
    return clean(max(zs) - min(zs)), clean(-min(zs)), clean(max(zs))


# --------------------------------------------------------------------------- #
# Shared tail parts
# --------------------------------------------------------------------------- #


def generate_rounded_stem(path: Path, num_arc: int = 6, radius: float = 0.08) -> tuple[list, list]:
    """Rounded-long-edge stem, X in [-0.5, 0.5], Y in [-0.4, 0.4], Z 0 -> -1."""
    half_x = PEN_WIDTH / 2.0
    half_y = THICKNESS / 2.0
    cx = half_x - radius
    cy = half_y - radius

    poly_xy = []
    for i in range(num_arc + 1):
        ang = (math.pi / 2.0) * (i / float(num_arc))
        poly_xy.append((cx + radius * math.cos(ang), cy + radius * math.sin(ang)))
    for i in range(num_arc + 1):
        ang = (math.pi / 2.0) + (math.pi / 2.0) * (i / float(num_arc))
        poly_xy.append((-cx + radius * math.cos(ang), cy + radius * math.sin(ang)))
    for i in range(num_arc + 1):
        ang = math.pi + (math.pi / 2.0) * (i / float(num_arc))
        poly_xy.append((-cx + radius * math.cos(ang), -cy + radius * math.sin(ang)))
    for i in range(num_arc + 1):
        ang = (1.5 * math.pi) + (math.pi / 2.0) * (i / float(num_arc))
        poly_xy.append((cx + radius * math.cos(ang), -cy + radius * math.sin(ang)))

    poly = ensure_ccw(poly_xy)
    tris = triangulate_polygon_2d(poly)
    n = len(poly)

    verts = [(x, y, 0.0) for x, y in poly] + [(x, y, -1.0) for x, y in poly]
    faces = []
    for i in range(n):
        j = (i + 1) % n
        v1, v2, v3, v4 = i + 1, j + 1, j + 1 + n, i + 1 + n
        faces.append((v1, v2, v3))
        faces.append((v1, v3, v4))
    for a, b, c in tris:
        faces.append((a + 1, c + 1, b + 1))
    for a, b, c in tris:
        faces.append((a + 1 + n, b + 1 + n, c + 1 + n))

    write_obj(
        path,
        "arrow_tail_unit",
        verts,
        faces,
        "Unit Stem Mesh with Rounded Longitudinal Edges & Sharp End Caps",
    )
    return verts, faces


def generate_beveled_stem(path: Path, expose_rear: bool = True) -> tuple[list, list]:
    """Unit stem with beveled long edges and a sharp head-socket face.

    The plan outline gets extra points one bevel in from each end so the long
    sides are beveled while the end faces stay flat. The front (head socket)
    edge is always sharp; the free rear edge is beveled when `expose_rear`
    (no cap) and kept sharp when a cap covers it, so both seams stay invisible.
    """
    b = BEVEL_SIZE
    # Taper points sit just past the corner's axial miter reach (one bevel) so
    # the bevel runs at full width up to the connection and stops in a short,
    # cut-like fade instead of tapering along the whole stem.
    t = SOCKET_TAPER
    poly = [
        (-HALF_PEN, 0.0),
        (HALF_PEN, 0.0),
        (HALF_PEN, -t),
        (HALF_PEN, -1.0 + t),
        (HALF_PEN, -1.0),
        (-HALF_PEN, -1.0),
        (-HALF_PEN, -1.0 + t),
        (-HALF_PEN, -t),
    ]
    rear_w = 1.0 if expose_rear else 0.0
    weights = [rear_w, rear_w, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0]
    return export_beveled(
        path,
        "arrow_tail_unit_beveled",
        poly,
        "Beveled Long Edges Stem, Sharp Head Socket" + (", Beveled Free End" if expose_rear else ", Sharp Cap Seam"),
        bevel_weights=weights,
    )


def round_cap_poly_xz(num_arc_pts: int = NUM_ARC):
    """Semicircular cap plan: flat face at Z = 0, dome toward -Z."""
    thick = PEN_WIDTH / 2.0
    poly_xz = [(-thick, 0.0)]
    for i in range(1, num_arc_pts):
        ang = math.pi + (math.pi * i / num_arc_pts)
        poly_xz.append((thick * math.cos(ang), thick * math.sin(ang)))
    poly_xz.append((thick, 0.0))
    return poly_xz


def generate_sharp_round_cap(path: Path) -> tuple[list, list]:
    """Semicircular tail cap with sharp rims (matches the Sharp finish)."""
    return export_sharp_extruded(
        path,
        "arrow_tail_round_end",
        round_cap_poly_xz(),
        "Round Tail End Cap Mesh with Sharp Rims",
    )


def generate_round_cap(
    path: Path,
    bevel_size: float = BEVEL_SIZE,
    bevel_steps: int = BEVEL_STEPS,
    num_arc_pts: int = NUM_ARC,
) -> tuple[list, list]:
    """Semicircular tail cap, flat face at Z = 0, bulge toward -Z, beveled rims."""
    poly = ensure_ccw(round_cap_poly_xz(num_arc_pts))
    normals = compute_selective_inward_normals_xz(poly)
    n = len(poly)
    half_y = THICKNESS / 2.0

    top_rings = []
    for k in range(bevel_steps + 1):
        angle = (math.pi / 2.0) * (k / float(bevel_steps))
        offset = bevel_size * (1.0 - math.cos(angle))
        y = (half_y - bevel_size) + bevel_size * math.sin(angle)
        top_rings.append([(x + offset * nx, y, z + offset * nz) for (x, z), (nx, nz) in zip(poly, normals)])

    bottom_rings = []
    for k in range(bevel_steps + 1):
        angle = (math.pi / 2.0) * (k / float(bevel_steps))
        offset = bevel_size * (1.0 - math.cos(angle))
        y = -(half_y - bevel_size) - bevel_size * math.sin(angle)
        bottom_rings.append([(x + offset * nx, y, z + offset * nz) for (x, z), (nx, nz) in zip(poly, normals)])

    verts = []
    b_cap_start = len(verts) + 1
    verts.extend(bottom_rings[-1])

    b_ring_starts = []
    for k in range(bevel_steps - 1, -1, -1):
        b_ring_starts.append(len(verts) + 1)
        verts.extend(bottom_rings[k])

    t_ring_starts = []
    for k in range(bevel_steps):
        t_ring_starts.append(len(verts) + 1)
        verts.extend(top_rings[k])

    t_cap_start = len(verts) + 1
    verts.extend(top_rings[-1])

    faces = []

    prev = b_cap_start
    for start in b_ring_starts:
        for i in range(n):
            j = (i + 1) % n
            faces.append((prev + i, prev + j, start + j))
            faces.append((prev + i, start + j, start + i))
        prev = start

    wall_b = b_ring_starts[-1]
    wall_t = t_ring_starts[0]
    for i in range(n):
        j = (i + 1) % n
        faces.append((wall_b + i, wall_b + j, wall_t + j))
        faces.append((wall_b + i, wall_t + j, wall_t + i))

    prev = wall_t
    for start in t_ring_starts[1:]:
        for i in range(n):
            j = (i + 1) % n
            faces.append((prev + i, prev + j, start + j))
            faces.append((prev + i, start + j, start + i))
        prev = start

    for i in range(n):
        j = (i + 1) % n
        faces.append((prev + i, prev + j, t_cap_start + j))
        faces.append((prev + i, t_cap_start + j, t_cap_start + i))

    inset_poly = [(v[0], v[2]) for v in top_rings[-1]]
    tris = triangulate_polygon_2d(inset_poly)
    for a, b, c in tris:
        faces.append((b_cap_start + a, b_cap_start + c, b_cap_start + b))
    for a, b, c in tris:
        faces.append((t_cap_start + a, t_cap_start + b, t_cap_start + c))

    write_obj(
        path,
        "arrow_tail_round_end",
        verts,
        faces,
        "Round Tail End Cap Mesh with Selective Beveled Rims",
    )
    return verts, faces


# --------------------------------------------------------------------------- #
# Manifest / validation helpers
# --------------------------------------------------------------------------- #


OBJ_RE = re.compile(r"^v\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)")
FACE_RE = re.compile(r"^f\s+")


def read_obj_stats(path: Path) -> dict:
    verts = []
    faces = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("v "):
            m = OBJ_RE.match(line)
            if m:
                verts.append(tuple(float(g) for g in m.groups()))
        elif FACE_RE.match(line):
            faces += 1
    xs = [v[0] for v in verts]
    ys = [v[1] for v in verts]
    zs = [v[2] for v in verts]
    return {
        "verts": len(verts),
        "tris": faces,
        "bbox": {
            "x": [round(clean(min(xs)), 6), round(clean(max(xs)), 6)],
            "y": [round(clean(min(ys)), 6), round(clean(max(ys)), 6)],
            "z": [round(clean(min(zs)), 6), round(clean(max(zs)), 6)],
        },
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def read_obj_vertices(path: Path) -> list[tuple[float, float, float]]:
    verts = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("v "):
            m = OBJ_RE.match(line)
            if m:
                verts.append(tuple(float(g) for g in m.groups()))
    return verts


def geometry_equivalent(a: Path, b: Path, tol: float = 1e-6) -> bool:
    va = read_obj_vertices(a)
    vb = read_obj_vertices(b)
    if len(va) != len(vb):
        return False
    sa = sorted((round(x / tol), round(y / tol), round(z / tol)) for x, y, z in va)
    sb = sorted((round(x / tol), round(y / tol), round(z / tol)) for x, y, z in vb)
    return sa == sb


def manifest_entry(path: Path, style: str, mode: str, finish: str, **extra) -> dict:
    stats = read_obj_stats(path)
    entry = {"style": style, "mode": mode, "finish": finish, **stats}
    entry.update(extra)
    return entry


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def generate(out_dir: Path, shared_out_dir: Path | None = None) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    shared_out_dir = shared_out_dir or out_dir
    shared_out_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, dict] = {}

    for style in STYLES:
        label = STYLE_LABELS[style]
        head = head_profile_xz(style)
        head_bevel, socket_weights = head_bevel_profile_xz(style)
        span, socket_to_apex, overhang = head_metrics(style)

        sharp = out_dir / f"arrow_head_{style.replace('-', '_')}.obj"
        bevel = out_dir / f"arrow_head_{style.replace('-', '_')}_beveled.obj"
        export_sharp_extruded(sharp, sharp.stem, head, f"3D head (sharp, socket origin): {label}")
        # Keep the socket edge sharp: its bevel would show as a groove where the
        # stem meets the head, so the connection must stay invisible. The taper
        # points confine the fade to a short cut at the socket.
        export_beveled(
            bevel,
            bevel.stem,
            head_bevel,
            f"3D head (beveled rim, sharp socket): {label}",
            bevel_weights=socket_weights,
        )
        manifest[sharp.name] = manifest_entry(
            sharp, style, "head", "sharp", socket_to_apex=socket_to_apex, overhang=overhang, span=span
        )
        manifest[bevel.name] = manifest_entry(
            bevel,
            style,
            "head",
            "beveled",
            socket_to_apex=socket_to_apex,
            overhang=overhang,
            span=span,
            bevel_size=BEVEL_SIZE,
            bevel_steps=BEVEL_STEPS,
        )

        single = out_dir / f"arrow_single_{style.replace('-', '_')}.obj"
        single_bevel = out_dir / f"arrow_single_{style.replace('-', '_')}_beveled.obj"
        union = single_profile_xz(style)
        tail_extent = single_tail_extent(style)
        total = tail_extent + socket_to_apex
        rear = "capped round tail" if style == "round-cap" else "flat rear"
        export_sharp_extruded(single, single.stem, union, f"Single arrow (sharp, {rear}): {label}")
        export_beveled(single_bevel, single_bevel.stem, union, f"Single arrow (beveled rim, {rear}): {label}")
        manifest[single.name] = manifest_entry(
            single,
            style,
            "single",
            "sharp",
            tail=tail_extent,
            socket_to_apex=socket_to_apex,
            overhang=overhang,
            total_length=total,
        )
        manifest[single_bevel.name] = manifest_entry(
            single_bevel,
            style,
            "single",
            "beveled",
            tail=tail_extent,
            socket_to_apex=socket_to_apex,
            overhang=overhang,
            total_length=total,
            bevel_size=BEVEL_SIZE,
            bevel_steps=BEVEL_STEPS,
        )

    # Shared tail parts
    sharp_stem = out_dir / "arrow_tail_unit.obj"
    sharp_poly = [(-HALF_PEN, 0.0), (HALF_PEN, 0.0), (HALF_PEN, -1.0), (-HALF_PEN, -1.0)]
    export_sharp_extruded(
        sharp_stem,
        "arrow_tail_unit",
        sharp_poly,
        "Sharp Extruded Mesh (No Bevels): arrow_tail_unit",
    )
    manifest[sharp_stem.name] = manifest_entry(sharp_stem, "shared", "stem", "sharp", tail=1.0)

    rounded_stem = shared_out_dir / "arrow_tail_unit_rounded.obj"
    generate_rounded_stem(rounded_stem)
    manifest[rounded_stem.name] = manifest_entry(rounded_stem, "shared", "stem", "rounded", tail=1.0)

    beveled_stem = out_dir / "arrow_tail_unit_beveled.obj"
    generate_beveled_stem(beveled_stem)
    manifest[beveled_stem.name] = manifest_entry(beveled_stem, "shared", "stem", "beveled", tail=1.0)

    cap = shared_out_dir / "arrow_tail_round_end_rounded.obj"
    generate_round_cap(cap)
    manifest[cap.name] = manifest_entry(cap, "shared", "cap", "beveled", depth=0.5)

    sharp_cap = out_dir / "arrow_tail_round_end_sharp.obj"
    generate_sharp_round_cap(sharp_cap)
    manifest[sharp_cap.name] = manifest_entry(sharp_cap, "shared", "cap", "sharp", depth=0.5)

    payload = {
        "generated_by": "scripts/arrows/generate_arrows.py",
        "model": {
            "pen_width": PEN_WIDTH,
            "thickness": THICKNESS,
            "tail_length": TAIL_LENGTH,
            "head_angle_deg": HEAD_ANGLE_DEG,
            "head_size_ratio": HEAD_SIZE_RATIO,
            "bevel_size": BEVEL_SIZE,
            "bevel_steps": BEVEL_STEPS,
        },
        "styles": {style: {"span": head_metrics(style)[0], "socket_to_apex": head_metrics(style)[1], "overhang": head_metrics(style)[2], "single_total": single_tail_extent(style) + head_metrics(style)[1]} for style in STYLES},
        "files": dict(sorted(manifest.items())),
    }
    (out_dir / "manifest.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return payload


def check_reference_assets(out_dir: Path, reference_dir: Path, shared_out_dir: Path | None = None) -> bool:
    shared_out_dir = shared_out_dir or out_dir
    references = [
        (out_dir, "arrow_head_filled.obj"),
        (out_dir, "arrow_tail_unit.obj"),
        (shared_out_dir, "arrow_tail_unit_rounded.obj"),
        (shared_out_dir, "arrow_tail_round_end_rounded.obj"),
    ]
    ok = True
    for generated_dir, name in references:
        generated = generated_dir / name
        reference = reference_dir / name
        if not generated.exists():
            print(f"MISSING generated: {generated}")
            ok = False
            continue
        if not reference.exists():
            print(f"MISSING reference: {reference}")
            ok = False
            continue
        same = geometry_equivalent(generated, reference)
        print(f"{'OK  ' if same else 'DIFF'} {name}")
        ok = ok and same
    return ok


def main() -> int:
    script = Path(__file__).resolve()
    default_out = script.parents[2] / "src" / "maps" / "ArrowGallery" / "meshes"
    default_shared_out = script.parents[2] / "src" / "layers" / "velocity" / "meshes"

    parser = argparse.ArgumentParser(description="Generate 2D/3D arrow documentation meshes.")
    parser.add_argument("--out", type=Path, default=default_out, help="Output mesh directory.")
    parser.add_argument(
        "--shared-out",
        type=Path,
        default=default_shared_out,
        help="Output directory for meshes shared with the velocity layers.",
    )
    parser.add_argument(
        "--check",
        type=Path,
        default=None,
        help="Optional path to app-damStabilityInspector/public/assets for geometry checks.",
    )
    args = parser.parse_args()

    payload = generate(args.out, args.shared_out)
    print(f"Generated {len(payload['files'])} OBJ assets")
    print(f"Gallery meshes: {args.out}")
    print(f"Shared tail meshes: {args.shared_out}")
    print(f"Manifest: {args.out / 'manifest.json'}")

    if args.check:
        return 0 if check_reference_assets(args.out, args.check, args.shared_out) else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
