#!/usr/bin/env python3
"""
Read normalized data/<city>/<district>.csv files, deduplicate at 號,
cluster points by village (村里), order villages by nearest-neighbor +
2-opt over centroids, then solve nearest-neighbor TSP within each village
so every village is covered by one contiguous stretch of the route.
Output one GeoJSON per district into docs/output/<city>/.
Coordinates are TWD97 (EPSG:3826) and converted to WGS84 (EPSG:4326).

Usage: generate_all.py [city ...]   (default: all cities under data/)
"""

import csv
import glob
import json
import math
import os
import re
import sys
import time
import numpy as np
from collections import defaultdict
from scipy.spatial import KDTree


def twd97_to_wgs84(x, y):
    a = 6378137.0
    b = 6356752.314245
    lng0 = 121.0 * math.pi / 180
    k0 = 0.9999
    dx = 250000

    e = math.sqrt(1 - (b / a) ** 2)
    e2 = e ** 2 / (1 - e ** 2)

    x = np.asarray(x, dtype=np.float64) - dx
    y = np.asarray(y, dtype=np.float64)
    M = y / k0

    mu = M / (a * (1 - e**2 / 4 - 3 * e**4 / 64 - 5 * e**6 / 256))
    e1 = (1 - math.sqrt(1 - e**2)) / (1 + math.sqrt(1 - e**2))

    J1 = 3 * e1 / 2 - 27 * e1**3 / 32
    J2 = 21 * e1**2 / 16 - 55 * e1**4 / 32
    J3 = 151 * e1**3 / 96
    J4 = 1097 * e1**4 / 512

    fp = mu + J1 * np.sin(2 * mu) + J2 * np.sin(4 * mu) + J3 * np.sin(6 * mu) + J4 * np.sin(8 * mu)

    C1 = e2 * np.cos(fp)**2
    T1 = np.tan(fp)**2
    R1 = a * (1 - e**2) / (1 - e**2 * np.sin(fp)**2)**1.5
    N1 = a / np.sqrt(1 - e**2 * np.sin(fp)**2)
    D = x / (N1 * k0)

    lat = fp - (N1 * np.tan(fp) / R1) * (
        D**2 / 2
        - (5 + 3 * T1 + 10 * C1 - 4 * C1**2 - 9 * e2) * D**4 / 24
        + (61 + 90 * T1 + 298 * C1 + 45 * T1**2 - 252 * e2 - 3 * C1**2) * D**6 / 720
    )
    lng = lng0 + (
        D
        - (1 + 2 * T1 + C1) * D**3 / 6
        + (5 - 2 * C1 + 28 * T1 - 3 * C1**2 + 8 * e2 + 24 * T1**2) * D**5 / 120
    ) / np.cos(fp)

    return np.degrees(lat), np.degrees(lng)


def nearest_neighbor_route(xy, start=0):
    n = len(xy)
    if n <= 1:
        return list(range(n))

    tree = KDTree(xy)
    visited = np.zeros(n, dtype=bool)
    order = [start]
    visited[start] = True
    current = start

    for step in range(n - 1):
        k = min(32, n - step)
        dists, idxs = tree.query(xy[current], k=k)
        found = False
        for d, j in zip(np.atleast_1d(dists), np.atleast_1d(idxs)):
            if not visited[j]:
                visited[j] = True
                order.append(j)
                current = j
                found = True
                break
        if not found:
            remaining = np.where(~visited)[0]
            deltas = xy[remaining] - xy[current]
            d2 = (deltas ** 2).sum(axis=1)
            best = remaining[np.argmin(d2)]
            visited[best] = True
            order.append(best)
            current = best

    return order


def two_opt(xy, order, max_passes=10):
    """2-opt improvement for small tours (village centroids)."""
    n = len(order)
    if n < 4:
        return order
    order = list(order)
    pts = xy[order]
    for _ in range(max_passes):
        improved = False
        for i in range(n - 2):
            for j in range(i + 2, n - 1):
                a, b = pts[i], pts[i + 1]
                c, d = pts[j], pts[j + 1]
                before = np.hypot(*(a - b)) + np.hypot(*(c - d))
                after = np.hypot(*(a - c)) + np.hypot(*(b - d))
                if after < before - 1e-9:
                    pts[i + 1:j + 1] = pts[i + 1:j + 1][::-1]
                    order[i + 1:j + 1] = order[i + 1:j + 1][::-1]
                    improved = True
        if not improved:
            break
    return order


def douglas_peucker(coords, epsilon):
    n = len(coords)
    if n <= 2:
        return coords
    keep = [False] * n
    keep[0] = True
    keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        start, end = stack.pop()
        if end - start < 2:
            continue
        c0 = coords[start]
        c1 = coords[end]
        dx = c1[0] - c0[0]
        dy = c1[1] - c0[1]
        line_len_sq = dx * dx + dy * dy
        max_dist = 0
        max_idx = start
        for i in range(start + 1, end):
            px = coords[i][0] - c0[0]
            py = coords[i][1] - c0[1]
            if line_len_sq == 0:
                dist = px * px + py * py
            else:
                t = (px * dx + py * dy) / line_len_sq
                if t < 0:
                    t = 0
                elif t > 1:
                    t = 1
                dist = (px - t * dx) ** 2 + (py - t * dy) ** 2
            if dist > max_dist:
                max_dist = dist
                max_idx = i
        if max_dist > epsilon * epsilon:
            keep[max_idx] = True
            stack.append((start, max_idx))
            stack.append((max_idx, end))
    return [coords[i] for i in range(n) if keep[i]]


def extract_dedup_key(row):
    if row.get("address"):
        addr = row["address"]
        m = re.search(r"號", addr)
        return addr[:m.end()] if m else addr
    num = str(row.get("number", ""))
    m = re.search(r"號", num)
    num_trunc = num[:m.end()] if m else num
    return (
        str(row.get("street", "")),
        str(row.get("area", "")),
        str(row.get("lane", "")),
        str(row.get("alley", "")),
        num_trunc,
    )


def haversine_km(c1, c2):
    dlat = math.radians(c2[1] - c1[1])
    dlon = math.radians(c2[0] - c1[0])
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(c1[1])) * math.cos(math.radians(c2[1])) * math.sin(dlon / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


SPEED_KMH = 15
MAX_KM = SPEED_KMH * 1
# Cut at a village boundary once a segment reaches this fraction of MAX_KM,
# so segments align with villages instead of splitting them.
SOFT_CUT_RATIO = 0.6
DP_EPSILON = 0.00005


def process_district(csv_path, city_name, output_base):
    dist = os.path.splitext(os.path.basename(csv_path))[0]

    points = {}
    with open(csv_path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            try:
                x = float(row["x"])
                y = float(row["y"])
            except (ValueError, TypeError, KeyError):
                continue
            key = extract_dedup_key(row)
            if key not in points:
                points[key] = (x, y, (row.get("village") or "").strip())

    n = len(points)
    if n == 0:
        print(f"  WARNING: no valid data in {csv_path}")
        return
    t0 = time.time()
    print(f"  {dist}: {n} points...", end=" ", flush=True)

    xy = np.array([(p[0], p[1]) for p in points.values()])
    villages = [p[2] for p in points.values()]

    # Group point indices by village; attach unlabeled points to the
    # village of their nearest labeled neighbor.
    groups = defaultdict(list)
    for i, v in enumerate(villages):
        groups[v].append(i)
    if "" in groups and len(groups) > 1:
        blanks = groups.pop("")
        labeled = [i for i in range(n) if villages[i]]
        tree = KDTree(xy[labeled])
        for i in blanks:
            _, j = tree.query(xy[i])
            groups[villages[labeled[j]]].append(i)

    # Order villages by NN + 2-opt over centroids.
    names = sorted(groups)
    centroids = np.array([xy[groups[v]].mean(axis=0) for v in names])
    v_order = nearest_neighbor_route(centroids)
    v_order = two_opt(centroids, v_order)

    # Route within each village, starting nearest to the previous endpoint.
    full_order = []
    chunk_sizes = []
    chunk_names = []
    prev_end = None
    for vi in v_order:
        idxs = groups[names[vi]]
        sub_xy = xy[idxs]
        if prev_end is None:
            start = 0
        else:
            deltas = sub_xy - prev_end
            start = int(np.argmin((deltas ** 2).sum(axis=1)))
        sub_order = nearest_neighbor_route(sub_xy, start)
        full_order.extend(idxs[k] for k in sub_order)
        chunk_sizes.append(len(sub_order))
        chunk_names.append(names[vi])
        prev_end = sub_xy[sub_order[-1]]

    lats, lngs = twd97_to_wgs84(xy[full_order, 0], xy[full_order, 1])

    # Simplify per village so boundaries survive for segment cutting.
    n_before = len(full_order)
    chunks = []
    pos = 0
    for size, vname in zip(chunk_sizes, chunk_names):
        coords = [
            [round(float(lngs[i]), 6), round(float(lats[i]), 6)]
            for i in range(pos, pos + size)
        ]
        pos += size
        chunks.append((vname, douglas_peucker(coords, DP_EPSILON)))
    n_after = sum(len(c) for _, c in chunks)

    # Split into segments, preferring cuts at village boundaries.
    segments = []
    seg_kms = []
    seg_villages = []

    def close_segment(coords, km, vnames):
        if len(coords) >= 2:
            segments.append(coords)
            seg_kms.append(round(km, 2))
            seg_villages.append(vnames)

    seg_coords = []
    seg_km = 0.0
    seg_vnames = []
    for vname, coords in chunks:
        if seg_coords and seg_km >= MAX_KM * SOFT_CUT_RATIO:
            close_segment(seg_coords, seg_km, seg_vnames)
            seg_coords = []
            seg_km = 0.0
            seg_vnames = []
        if not seg_vnames or seg_vnames[-1] != vname:
            seg_vnames = seg_vnames + [vname]
        for c in coords:
            if not seg_coords:
                seg_coords.append(c)
                continue
            d = haversine_km(seg_coords[-1], c)
            if seg_km + d > MAX_KM and len(seg_coords) >= 2:
                close_segment(seg_coords, seg_km, seg_vnames)
                seg_coords = [c]
                seg_km = 0.0
                seg_vnames = [vname]
            else:
                seg_coords.append(c)
                seg_km += d
    close_segment(seg_coords, seg_km, seg_vnames)

    features = []
    for si, seg in enumerate(segments):
        features.append({
            "type": "Feature",
            "properties": {
                "district": dist,
                "segment": si + 1,
                "total_segments": len(segments),
                "km": seg_kms[si],
                "villages": seg_villages[si],
            },
            "geometry": {"type": "LineString", "coordinates": seg},
        })

    geojson = {"type": "FeatureCollection", "features": features}
    out_dir = os.path.join(output_base, city_name)
    os.makedirs(out_dir, exist_ok=True)
    outpath = os.path.join(out_dir, f"{dist}.geojson")
    with open(outpath, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False)
    elapsed = time.time() - t0
    print(
        f"{len(groups)} villages, {len(segments)} segments, "
        f"{n_before}->{n_after} pts ({100*n_after/n_before:.0f}%), {elapsed:.1f}s",
        flush=True,
    )


def main():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    output_base = os.path.join(base_dir, "docs", "output")
    data_dir = os.path.join(base_dir, "data")
    os.makedirs(output_base, exist_ok=True)

    cities = sorted(
        d for d in os.listdir(data_dir)
        if os.path.isdir(os.path.join(data_dir, d))
    )
    if len(sys.argv) > 1:
        cities = [c for c in cities if c in sys.argv[1:]]

    for city in cities:
        files = sorted(glob.glob(os.path.join(data_dir, city, "*.csv")))
        print(f"\n=== {city} ({len(files)} district(s)) ===")
        for fpath in files:
            process_district(fpath, city, output_base)

    print("\nDone.")


if __name__ == "__main__":
    main()
