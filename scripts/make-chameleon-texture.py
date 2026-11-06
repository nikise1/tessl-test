"""Build a high-resolution green chameleon skin from the lizard UV unwrap.

The 3DS file names a 256×256 map. This script rasterizes the skin's UV
islands, shades them in world space (dorsal ridge, flanks, belly, tail
bands), and writes a diffuse map plus matching normal and roughness maps.
"""

import json
import os
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
FACES_PATH = Path("/tmp/uv-faces.json")

EXPORT_FACES = r"""
import fs from "fs";
import { Vector3 } from "three";
import { load3DS } from "./src/load3ds.js";

const bytes = fs.readFileSync("public/models/test_lizard_01.3ds");
const loaded = load3DS(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
loaded.object.updateMatrixWorld(true);
const geo = loaded.skin.geometry;
const uv = geo.attributes.uv;
const pos = geo.attributes.position;
const idx = geo.index;
const nrm = geo.attributes.normal;
const point = new Vector3();
const normal = new Vector3();
const faces = [];
for (let i = 0; i < idx.count; i += 3) {
  const ids = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
  const uvs = [];
  const ws = [];
  const ns = [];
  for (const id of ids) {
    uvs.push([uv.getX(id), uv.getY(id)]);
    point.fromBufferAttribute(pos, id);
    loaded.skin.localToWorld(point);
    ws.push([point.x, point.y, point.z]);
    normal.fromBufferAttribute(nrm, id);
    normal.transformDirection(loaded.skin.matrixWorld);
    ns.push([normal.x, normal.y, normal.z]);
  }
  faces.push({ uvs, ws, ns });
}
fs.writeFileSync(process.env.FACES_PATH, JSON.stringify(faces));
"""
SIZE = 2048
CELL = 9.0
DILATE = 14

BODY, FEET, EYE, JAW, SNOUT = 1, 2, 3, 4, 5


def uhash(x):
    x = np.asarray(x, dtype=np.uint32)
    x ^= x >> np.uint32(16)
    x *= np.uint32(0x7FEB352D)
    x ^= x >> np.uint32(15)
    x *= np.uint32(0x846CA68B)
    x ^= x >> np.uint32(16)
    return x


def hash_cell(cell):
    c = cell.astype(np.uint32)
    mixed = c[:, 0] * np.uint32(374761393)
    mixed ^= c[:, 1] * np.uint32(668265263)
    mixed ^= c[:, 2] * np.uint32(1274126177)
    return uhash(mixed)


def hash_unit(cell, salt):
    h = hash_cell(cell)
    if salt:
        h = uhash(h ^ np.uint32(salt))
    return (h & np.uint32(0xFFFF)).astype(np.float32) / np.float32(65535.0)


def value_noise(points):
    origin = np.floor(points).astype(np.int32)
    frac = points - origin
    fade = frac * frac * (3.0 - 2.0 * frac)
    total = np.zeros(points.shape[0], np.float32)
    for dz in (0, 1):
        for dy in (0, 1):
            for dx in (0, 1):
                corner = origin + np.array([dx, dy, dz], np.int32)
                value = hash_unit(corner, 0)
                wx = fade[:, 0] if dx else 1.0 - fade[:, 0]
                wy = fade[:, 1] if dy else 1.0 - fade[:, 1]
                wz = fade[:, 2] if dz else 1.0 - fade[:, 2]
                total += value * wx * wy * wz
    return total


def worley(points, cell_size):
    base = np.floor(points / cell_size).astype(np.int32)
    nearest = np.full(points.shape[0], np.float32(1e9), np.float32)
    second = np.full(points.shape[0], np.float32(1e9), np.float32)
    owner = np.zeros((points.shape[0], 3), np.int32)
    for dz in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                cell = base + np.array([dx, dy, dz], np.int32)
                jitter = np.stack(
                    [
                        hash_unit(cell, 0xA511E9B3),
                        hash_unit(cell, 0x63D83595),
                        hash_unit(cell, 0x9E3779B9),
                    ],
                    axis=1,
                )
                feature = (cell.astype(np.float32) + jitter) * np.float32(cell_size)
                dist = np.linalg.norm(points - feature, axis=1).astype(np.float32)
                closer = dist < nearest
                between = (dist < second) & ~closer
                second = np.where(closer, nearest, np.where(between, dist, second))
                owner = np.where(closer[:, None], cell, owner)
                nearest = np.minimum(nearest, dist)
    return nearest, second, owner


def smoothstep(edge0, edge1, value):
    t = np.clip((value - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def mix(a, b, t):
    return a * (1.0 - t) + b * t


def classify_islands(faces):
    parent = list(range(len(faces)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    buckets = {}
    for index, face in enumerate(faces):
        for u, v in face["uvs"]:
            buckets.setdefault((round(u, 4), round(v, 4)), []).append(index)
    for ids in buckets.values():
        for other in ids[1:]:
            union(ids[0], other)

    groups = {}
    for index in range(len(faces)):
        groups.setdefault(find(index), []).append(index)

    labels = np.zeros(len(faces), np.uint8)
    for ids in groups.values():
        us, vs = [], []
        for index in ids:
            for u, v in faces[index]["uvs"]:
                us.append(u)
                vs.append(v)
        u = 0.5 * (min(us) + max(us))
        v = 0.5 * (min(vs) + max(vs))
        span = max(max(us) - min(us), max(vs) - min(vs))
        if span > 0.45:
            region = BODY
        elif u < 0.4 and v > 0.28:
            region = EYE
        elif u > 0.65 and v > 0.6:
            region = FEET
        elif v < 0.28 and u > 0.4:
            region = JAW
        else:
            region = SNOUT
        labels[ids] = region
    return labels


def rasterize(faces, labels, size):
    position = np.zeros((size, size, 3), np.float32)
    normal = np.zeros((size, size, 3), np.float32)
    region = np.zeros((size, size), np.uint8)

    def edge(y, x0, y0, x1, y1):
        if abs(y1 - y0) < 1e-8:
            return x0
        t = (y - y0) / (y1 - y0)
        return x0 + (x1 - x0) * t

    for face, label in zip(faces, labels):
        corners = []
        for (u, v), world, nrm in zip(face["uvs"], face["ws"], face["ns"]):
            corners.append((u * (size - 1), (1.0 - v) * (size - 1), world, nrm))
        centroid_x = sum(c[0] for c in corners) / 3
        centroid_y = sum(c[1] for c in corners) / 3
        expanded = []
        for x, y, world, nrm in corners:
            dx, dy = x - centroid_x, y - centroid_y
            length = (dx * dx + dy * dy) ** 0.5 or 1.0
            expanded.append((x + dx / length * 1.6, y + dy / length * 1.6, world, nrm))
        order = sorted(range(3), key=lambda i: expanded[i][1])
        (x0, y0, w0, n0), (x1, y1, w1, n1), (x2, y2, w2, n2) = (expanded[i] for i in order)
        y_start = max(0, int(np.floor(y0)))
        y_end = min(size - 1, int(np.ceil(y2)))
        for y in range(y_start, y_end + 1):
            sample_y = y + 0.5
            if sample_y < y1:
                xa = edge(sample_y, x0, y0, x1, y1)
                xb = edge(sample_y, x0, y0, x2, y2)
                ta = 0.0 if abs(y1 - y0) < 1e-8 else np.clip((sample_y - y0) / (y1 - y0), 0, 1)
                tb = 0.0 if abs(y2 - y0) < 1e-8 else np.clip((sample_y - y0) / (y2 - y0), 0, 1)
                wa, wb = mix(np.array(w0), np.array(w1), ta), mix(np.array(w0), np.array(w2), tb)
                na, nb = mix(np.array(n0), np.array(n1), ta), mix(np.array(n0), np.array(n2), tb)
            else:
                xa = edge(sample_y, x1, y1, x2, y2)
                xb = edge(sample_y, x0, y0, x2, y2)
                ta = 0.0 if abs(y2 - y1) < 1e-8 else np.clip((sample_y - y1) / (y2 - y1), 0, 1)
                tb = 0.0 if abs(y2 - y0) < 1e-8 else np.clip((sample_y - y0) / (y2 - y0), 0, 1)
                wa, wb = mix(np.array(w1), np.array(w2), ta), mix(np.array(w0), np.array(w2), tb)
                na, nb = mix(np.array(n1), np.array(n2), ta), mix(np.array(n0), np.array(n2), tb)
            if xa > xb:
                xa, xb = xb, xa
                wa, wb = wb, wa
                na, nb = nb, na
            x_start = max(0, int(np.floor(xa)))
            x_end = min(size - 1, int(np.ceil(xb)))
            span = max(xb - xa, 1e-5)
            for x in range(x_start, x_end + 1):
                t = np.clip((x + 0.5 - xa) / span, 0.0, 1.0)
                position[y, x] = mix(wa, wb, t)
                normal[y, x] = mix(na, nb, t)
                region[y, x] = label
    return position, normal, region


def shade(position, normal, region):
    mask = region > 0
    ys, xs = np.nonzero(mask)
    points = position[ys, xs]
    norms = normal[ys, xs]
    lengths = np.linalg.norm(norms, axis=1, keepdims=True)
    norms = norms / np.maximum(lengths, 1e-6)
    regions = region[ys, xs]
    gloss = np.zeros(points.shape[0], np.float32)
    z = points[:, 2]
    z_min, z_max = float(z.min()), float(z.max())
    along = (z - z_min) / max(z_max - z_min, 1e-6)
    up = norms[:, 2]

    # Palette sits closer together than the first pass so the greens are quieter,
    # while the scale height below still draws the hide.
    belly = np.array([0.46, 0.58, 0.30], np.float32)
    flank = np.array([0.14, 0.40, 0.18], np.float32)
    back = np.array([0.20, 0.48, 0.20], np.float32)
    crest = np.array([0.50, 0.58, 0.24], np.float32)
    leaf = np.array([0.32, 0.52, 0.20], np.float32)
    teal = np.array([0.16, 0.44, 0.32], np.float32)

    color = mix(belly, flank, smoothstep(-0.75, 0.05, up)[:, None])
    color = mix(color, back, smoothstep(0.0, 0.62, up)[:, None])
    crest_amount = smoothstep(0.42, 0.92, up) * (0.35 + 0.65 * smoothstep(0.35, 0.85, along))
    color = mix(color, crest, (crest_amount * 0.38)[:, None])
    color = mix(color, leaf, (smoothstep(0.55, 0.9, along) * smoothstep(-0.2, 0.7, up) * 0.16)[:, None])
    side = (1.0 - np.abs(up)) * smoothstep(-0.2, 0.35, up)
    color = mix(color, teal, (side * 0.10)[:, None])

    mottled = value_noise(points * 0.035 + 4.0)
    fine = value_noise(points * 0.08 + 18.0)
    color = mix(color, color * np.array([0.78, 0.86, 0.70], np.float32), (smoothstep(0.58, 0.86, mottled) * 0.28)[:, None])
    color = mix(color, np.array([0.46, 0.58, 0.26], np.float32), (smoothstep(0.72, 0.92, fine) * 0.18)[:, None])

    band = 0.5 + 0.5 * np.sin(z * 0.21 + value_noise(points * 0.02) * 1.4)
    tail = smoothstep(70.0, -20.0, z) * smoothstep(0.42, 0.78, band)
    color *= (1.0 - 0.20 * tail)[:, None]

    nearest, second, owner = worley(points, CELL)
    radius = 0.34 + 0.16 * hash_unit(owner, 0x51F0C5B1)
    dist = nearest / CELL
    edge = smoothstep(radius, radius + 0.16, dist)
    crack = smoothstep(0.05, 0.16, (second - nearest) / CELL)
    height = (1.0 - edge) * (0.55 + 0.45 * crack)
    height = height ** 1.15
    scale_tint = 0.92 + 0.16 * hash_unit(owner, 0xC2B2AE35)
    color *= (0.86 + 0.20 * height)[:, None] * scale_tint[:, None]
    color *= (1.0 - 0.10 * (1.0 - crack))[:, None]

    # Feet share one chart. A muted olive, with a warmer pad, still scaled.
    foot = regions == FEET
    if np.any(foot):
        fu = xs[foot] / (SIZE - 1)
        fv = 1.0 - ys[foot] / (SIZE - 1)
        fu = (fu - fu.mean()) / max(fu.std(), 1e-4)
        fv = (fv - fv.mean()) / max(fv.std(), 1e-4)
        pad = np.exp(-0.5 * (fu * fu + fv * fv))
        color[foot] = mix(color[foot], np.array([0.36, 0.34, 0.16], np.float32), 0.32)
        color[foot] = mix(color[foot], np.array([0.50, 0.42, 0.22], np.float32), pad[:, None] * 0.35)

    # The lower throat on the body chart is the outside of the jaw.
    throat = (regions == BODY) & (along > 0.70) & (up < -0.05)
    color[throat] = mix(color[throat], np.array([0.48, 0.40, 0.22], np.float32), 0.22)
    tip = (regions == BODY) & (along < 0.16)
    color[tip] = mix(color[tip], np.array([0.34, 0.28, 0.14], np.float32), 0.22)

    # Jaw chart is the mouth cavity (roof and inner lip share it). Soft tissue,
    # not the body scales: a few low palate ridges and a darker center.
    jaw = regions == JAW
    mouth = np.zeros(points.shape[0], np.float32)
    if np.any(jaw):
        ju = xs[jaw].astype(np.float32) / (SIZE - 1)
        jv = 1.0 - ys[jaw].astype(np.float32) / (SIZE - 1)
        ju = (ju - float(ju.mean())) / max(float(ju.std()), 1e-4)
        jv = (jv - float(jv.mean())) / max(float(jv.std()), 1e-4)
        wave = np.sin(ju * 3.4)
        crest = np.clip(wave, 0.0, 1.0) ** 0.65
        groove = np.clip(-wave, 0.0, 1.0) ** 1.15
        grain = value_noise(points[jaw] * 0.35 + 9.0)
        cavity = np.exp(-0.42 * (ju * ju * 0.7 + jv * jv))
        deep = np.array([0.15, 0.032, 0.028], np.float32)
        tissue = np.array([0.42, 0.12, 0.10], np.float32)
        lip = np.array([0.50, 0.17, 0.14], np.float32)
        flesh = mix(tissue, deep, (cavity * 0.7)[:, None])
        flesh = mix(flesh, lip, ((1.0 - cavity) * 0.32)[:, None])
        flesh *= (0.76 + 0.30 * crest)[:, None]
        flesh = mix(flesh, deep, (groove * 0.38)[:, None])
        raphe = np.exp(-(ju * ju) * 2.4)
        flesh = mix(flesh, flesh * np.array([1.12, 1.04, 1.0], np.float32), (raphe * 0.22)[:, None])
        flesh *= (0.94 + 0.08 * grain)[:, None]
        color[jaw] = flesh
        height[jaw] = 0.28 + 0.26 * crest - 0.06 * groove
        mouth[jaw] = 1.0

    snout = regions == SNOUT
    if np.any(snout):
        su = xs[snout] / (SIZE - 1)
        sv = 1.0 - ys[snout] / (SIZE - 1)
        su = (su - su.mean()) / max(float(np.ptp(su)), 1e-4)
        sv = (sv - sv.mean()) / max(float(np.ptp(sv)), 1e-4)
        pit = np.exp(-6.0 * (su * su + sv * sv))
        color[snout] = mix(color[snout], np.array([0.16, 0.22, 0.08], np.float32), pit[:, None] * 0.75)

    eye = regions == EYE
    if np.any(eye):
        eu = xs[eye].astype(np.float32) / (SIZE - 1)
        ev = 1.0 - ys[eye].astype(np.float32) / (SIZE - 1)
        cu, cv = float(eu.mean()), float(ev.mean())
        radius = float(np.sqrt(((eu - cu) ** 2 + (ev - cv) ** 2).mean())) * 1.55
        du = (eu - cu) / radius
        dv = (ev - cv) / radius
        radial = np.sqrt(du * du + dv * dv)
        lid = color[eye]
        iris = np.array([0.72, 0.46, 0.12], np.float32)
        streak = 0.5 + 0.5 * np.sin(np.arctan2(dv, du) * 10.0 + radial * 18.0)
        iris = mix(iris, np.array([0.48, 0.55, 0.16], np.float32), (0.28 + 0.28 * streak)[:, None])
        pupil = radial < 0.16
        iris_band = (radial >= 0.16) & (radial < 0.34)
        rim = (radial >= 0.34) & (radial < 0.46)
        eye_color = lid.copy()
        eye_color[iris_band] = iris[iris_band]
        eye_color[rim] = mix(lid[rim], np.array([0.05, 0.10, 0.03], np.float32), 0.72)
        eye_color[pupil] = np.array([0.02, 0.015, 0.01], np.float32)
        highlight = np.exp(-((du + 0.04) ** 2 + (dv - 0.045) ** 2) / 0.0012)
        eye_color[pupil] = np.clip(eye_color[pupil] + highlight[pupil, None] * 0.65, 0, 1)
        color[eye] = eye_color
        height[eye] = np.where(pupil, 0.15, np.where(iris_band, 0.35, height[eye]))
        gloss[np.flatnonzero(eye)[pupil | iris_band]] = 1.0

    out_color = np.zeros((SIZE, SIZE, 3), np.float32)
    out_height = np.zeros((SIZE, SIZE), np.float32)
    out_gloss = np.zeros((SIZE, SIZE), np.float32)
    out_mouth = np.zeros((SIZE, SIZE), np.float32)
    out_color[ys, xs] = np.clip(color, 0, 1)
    out_height[ys, xs] = height
    out_gloss[ys, xs] = gloss
    out_mouth[ys, xs] = mouth
    return out_color, out_height, out_gloss, out_mouth, mask


def dilate(color, height, mask, iterations):
    height_px, width_px = mask.shape
    offsets = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx]
    for _ in range(iterations):
        grown_color = color.copy()
        grown_height = height.copy()
        grown_mask = mask.copy()
        for dy, dx in offsets:
            src_y = slice(max(0, -dy), height_px - max(0, dy))
            src_x = slice(max(0, -dx), width_px - max(0, dx))
            dst_y = slice(max(0, dy), height_px - max(0, -dy))
            dst_x = slice(max(0, dx), width_px - max(0, -dx))
            take = mask[src_y, src_x] & ~grown_mask[dst_y, dst_x]
            if not np.any(take):
                continue
            grown_color[dst_y, dst_x][take] = color[src_y, src_x][take]
            grown_height[dst_y, dst_x][take] = height[src_y, src_x][take]
            grown_mask[dst_y, dst_x][take] = True
        color, height, mask = grown_color, grown_height, grown_mask
    return color, height, mask


def normals_from_height(height, mask):
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * 0.5
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * 0.5
    strength = 4.8
    nx = -dx * strength
    ny = dy * strength
    nz = np.ones_like(height)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    normal = np.stack((nx / length, ny / length, nz / length), axis=-1)
    encoded = np.full_like(normal, 0.5)
    encoded[mask] = normal[mask] * 0.5 + 0.5
    return encoded


def roughness_from_height(height, gloss, mouth, mask):
    rough = np.full((SIZE, SIZE), np.float32(0.0))
    # Satin scales: raised centers are a little smoother than the cracks.
    rough[mask] = np.clip(0.82 - height[mask] * 0.22, 0.52, 0.9)
    # The mouth is a bit wetter than the hide. The iris stays the glossy part.
    rough[mouth > 0.5] = np.float32(0.55)
    rough[gloss > 0.5] = np.float32(0.18)
    return rough


def save_rgb(path, array):
    image = Image.fromarray(np.clip(array * 255.0 + 0.5, 0, 255).astype(np.uint8), "RGB")
    image.save(path, optimize=True)
    print(path, image.size)


def save_gray(path, array):
    image = Image.fromarray(np.clip(array * 255.0 + 0.5, 0, 255).astype(np.uint8), "L")
    image.save(path, optimize=True)
    print(path, image.size)


def main():
    subprocess.run(
        ["node", "--input-type=module", "-e", EXPORT_FACES],
        cwd=ROOT,
        check=True,
        env={**os.environ, "FACES_PATH": str(FACES_PATH)},
    )
    faces = json.loads(FACES_PATH.read_text())
    labels = classify_islands(faces)
    print("region counts", {int(k): int((labels == k).sum()) for k in np.unique(labels)})
    position, normal, region = rasterize(faces, labels, SIZE)
    color, height, gloss, mouth, mask = shade(position, normal, region)
    color, height, mask = dilate(color, height, mask, DILATE)
    normal_map = normals_from_height(height, mask)
    rough = roughness_from_height(height, gloss, mouth, mask)
    out = ROOT / "public" / "models"
    save_rgb(out / "LIZARD_M.png", color)
    save_rgb(out / "LIZARD_M_normal.png", normal_map)
    save_gray(out / "LIZARD_M_roughness.png", rough)
    preview = Image.fromarray(np.clip(color * 255.0 + 0.5, 0, 255).astype(np.uint8), "RGB")
    preview.resize((768, 768), Image.Resampling.BOX).save("/tmp/chameleon-preview.png")
    Image.fromarray(np.clip(normal_map * 255.0 + 0.5, 0, 255).astype(np.uint8), "RGB").resize((768, 768), Image.Resampling.BOX).save("/tmp/chameleon-normal-preview.png")


if __name__ == "__main__":
    main()
