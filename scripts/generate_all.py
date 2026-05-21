#!/usr/bin/env python3
"""
Read all raw/*.csv and raw/*.xlsx files, normalise varying column names,
deduplicate at 號, group by 鄉鎮市區代碼, solve nearest-neighbor TSP per
district using KDTree, output one GeoJSON per district into output/<city>/.
Coordinates are TWD97 (EPSG:3826) and converted to WGS84 (EPSG:4326).
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


COLUMN_MAP = {
    "鄉鎮市區代碼": "district",
    "areacode": "district",
    " districtCode": "district",
    "districtCode": "district",

    "街、路段": "street",
    "街路段": "street",
    "街或路段": "street",
    "街_路段": "street",
    "street、road、section": "street",
    " streetRoadSection": "street",
    "streetRoadSection": "street",
    "街（路段）": "street",

    "地區": "area",
    " area": "area",

    "巷": "lane",
    " lane": "lane",

    "弄": "alley",
    " alley": "alley",

    "號": "number",
    "號樓": "number",
    "number": "number",
    " houseNumber": "number",
    "houseNumber": "number",

    "地址": "address",

    "橫座標": "x",
    "橫坐標": "x",
    "TWD97橫坐標": "x",
    "x_3826": "x",
    " coordinateX": "x",
    "coordinateX": "x",

    "縱座標": "y",
    "縱坐標": "y",
    "TWD97縱坐標": "y",
    "y_3826": "y",
    " coordinateY": "y",
    "coordinateY": "y",
}


def normalise_row(header_map, raw_row):
    mapped = {}
    for orig_col, value in raw_row.items():
        key = header_map.get(orig_col)
        if key:
            mapped[key] = (value or "").strip() if isinstance(value, str) else value
    return mapped


def build_header_map(columns):
    hmap = {}
    for col in columns:
        norm = COLUMN_MAP.get(col)
        if not norm:
            norm = COLUMN_MAP.get(col.strip())
        if norm:
            hmap[col] = norm
    return hmap


def read_csv(path):
    for enc in ("utf-8-sig", "big5", "cp950"):
        try:
            with open(path, encoding=enc) as f:
                reader = csv.DictReader(f)
                header_map = build_header_map(reader.fieldnames)
                if "district" not in header_map.values():
                    continue
                if "x" not in header_map.values() or "y" not in header_map.values():
                    continue
                rows = []
                for raw in reader:
                    rows.append(normalise_row(header_map, raw))
                return rows
        except (UnicodeDecodeError, UnicodeError):
            continue
    # Retry with errors='replace' for files with mixed/corrupt encoding
    for enc in ("big5", "cp950", "utf-8"):
        try:
            with open(path, encoding=enc, errors="replace") as f:
                reader = csv.DictReader(f)
                header_map = build_header_map(reader.fieldnames)
                if "district" not in header_map.values():
                    continue
                if "x" not in header_map.values() or "y" not in header_map.values():
                    continue
                rows = []
                for raw in reader:
                    rows.append(normalise_row(header_map, raw))
                return rows
        except Exception:
            continue
    return None


def read_xlsx(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    header = [str(h) if h is not None else "" for h in next(rows_iter)]
    header_map = build_header_map(header)
    if "district" not in header_map.values():
        wb.close()
        return None
    rows = []
    for raw_values in rows_iter:
        raw_row = dict(zip(header, raw_values))
        rows.append(normalise_row(header_map, raw_row))
    wb.close()
    return rows


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


def nearest_neighbor_tsp_kdtree(xy):
    n = len(xy)
    if n <= 1:
        return list(range(n))

    tree = KDTree(xy)
    visited = np.zeros(n, dtype=bool)
    order = [0]
    visited[0] = True
    current = 0

    for step in range(n - 1):
        k = min(32, n - step)
        dists, idxs = tree.query(xy[current], k=k)
        found = False
        for d, j in zip(dists, idxs):
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


def extract_address(row):
    if "address" in row and row["address"]:
        return row["address"]
    addr = ""
    if row.get("street"):
        addr += str(row["street"])
    if row.get("area"):
        addr += str(row["area"])
    if row.get("lane"):
        v = str(row["lane"])
        addr += v if "巷" in v else v + "巷"
    if row.get("alley"):
        v = str(row["alley"])
        addr += v if "弄" in v else v + "弄"
    if row.get("number"):
        addr += str(row["number"])
    return addr


def extract_dedup_key(row):
    if "address" in row and row["address"]:
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


def process_rows(rows, city_name, output_base):
    districts = defaultdict(dict)

    for row in rows:
        dist = row.get("district")
        if not dist:
            continue
        dist = str(dist).strip()
        if not dist:
            continue

        try:
            x = float(row["x"])
            y = float(row["y"])
        except (ValueError, TypeError, KeyError):
            continue

        key = extract_dedup_key(row)
        if key not in districts[dist]:
            addr = extract_address(row)
            districts[dist][key] = (x, y, addr)

    if not districts:
        print(f"  WARNING: no valid data found for {city_name}")
        return

    out_dir = os.path.join(output_base, city_name)
    os.makedirs(out_dir, exist_ok=True)

    total_districts = len(districts)
    for idx, (dist, points_dict) in enumerate(sorted(districts.items()), 1):
        points = list(points_dict.values())
        n = len(points)
        t0 = time.time()
        print(f"  [{idx}/{total_districts}] District {dist}: {n} points...", end=" ", flush=True)

        xs = [p[0] for p in points]
        ys = [p[1] for p in points]

        xy = np.column_stack([xs, ys])
        order = nearest_neighbor_tsp_kdtree(xy)

        xs_arr = np.array(xs)
        ys_arr = np.array(ys)
        lats, lngs = twd97_to_wgs84(xs_arr, ys_arr)

        ordered_coords = []
        for oi in order:
            lng_r = round(float(lngs[oi]), 6)
            lat_r = round(float(lats[oi]), 6)
            ordered_coords.append([lng_r, lat_r])

        n_before = len(ordered_coords)
        ordered_coords = douglas_peucker(ordered_coords, 0.00005)
        n_after = len(ordered_coords)

        SPEED_KMH = 15
        MAX_KM = SPEED_KMH * 1
        segments = []
        seg_coords = [ordered_coords[0]]
        seg_km = 0.0
        seg_kms = []
        for i in range(1, len(ordered_coords)):
            c1 = ordered_coords[i - 1]
            c2 = ordered_coords[i]
            dlat = math.radians(c2[1] - c1[1])
            dlon = math.radians(c2[0] - c1[0])
            a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(c1[1])) * math.cos(math.radians(c2[1])) * math.sin(dlon / 2) ** 2
            d = 6371 * 2 * math.asin(math.sqrt(a))
            if seg_km + d > MAX_KM and len(seg_coords) >= 2:
                segments.append(seg_coords)
                seg_kms.append(round(seg_km, 2))
                seg_coords = [c2]
                seg_km = 0.0
            else:
                seg_coords.append(c2)
                seg_km += d
        if len(seg_coords) >= 2:
            segments.append(seg_coords)
            seg_kms.append(round(seg_km, 2))

        features = []
        for si, seg in enumerate(segments):
            features.append({
                "type": "Feature",
                "properties": {
                    "district": dist,
                    "segment": si + 1,
                    "total_segments": len(segments),
                    "km": seg_kms[si],
                },
                "geometry": {"type": "LineString", "coordinates": seg},
            })

        geojson = {"type": "FeatureCollection", "features": features}
        outpath = os.path.join(out_dir, f"{dist}.geojson")
        with open(outpath, "w", encoding="utf-8") as f:
            json.dump(geojson, f, ensure_ascii=False)
        elapsed = time.time() - t0
        print(f"{len(segments)} segments, {n_before}->{n_after} pts ({100*n_after/n_before:.0f}%), {elapsed:.1f}s", flush=True)


def main():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    output_base = os.path.join(base_dir, "docs", "output")
    raw_dir = os.path.join(base_dir, "raw")
    os.makedirs(output_base, exist_ok=True)

    raw_files = sorted(glob.glob(os.path.join(raw_dir, "*.csv"))) + sorted(glob.glob(os.path.join(raw_dir, "*.xlsx")))

    city_groups = defaultdict(list)
    for fpath in raw_files:
        basename = os.path.splitext(os.path.basename(fpath))[0]
        city = re.sub(r"_\d+$", "", basename)
        city_groups[city].append(fpath)

    for city, files in sorted(city_groups.items()):
        print(f"\n=== {city} ({len(files)} file(s)) ===")
        all_rows = []
        for fpath in files:
            print(f"  Reading {fpath}...")
            if fpath.endswith(".csv"):
                rows = read_csv(fpath)
            else:
                rows = read_xlsx(fpath)
            if rows is None:
                print(f"  SKIPPED (no valid address columns found)")
                continue
            print(f"  -> {len(rows)} rows")
            all_rows.extend(rows)

        if all_rows:
            process_rows(all_rows, city, output_base)

    print("\nDone.")


if __name__ == "__main__":
    main()
