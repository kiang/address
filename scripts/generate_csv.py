#!/usr/bin/env python3
"""
Read all raw/*.csv and raw/*.xlsx files, normalise column names and encoding,
output one UTF-8 CSV per district into data/<city>/<district_code>.csv
with unified columns.
"""

import csv
import glob
import os
import re
import time
from collections import defaultdict


COLUMN_MAP = {
    "省市縣市代碼": "city_code",
    "countycode": "city_code",
    "cityCode": "city_code",
    "縣市別代碼": "city_code",

    "鄉鎮市區代碼": "district_code",
    "areacode": "district_code",
    " districtCode": "district_code",
    "districtCode": "district_code",

    "村里": "village",
    " village": "village",
    "village": "village",

    "鄰": "neighbor",
    " neighborhood": "neighbor",
    "neighbor": "neighbor",

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

OUTPUT_COLUMNS = [
    "city_code", "district_code", "village", "neighbor",
    "street", "area", "lane", "alley", "number", "address",
    "x", "y",
]


def build_header_map(columns):
    hmap = {}
    for col in columns:
        norm = COLUMN_MAP.get(col)
        if not norm:
            norm = COLUMN_MAP.get(col.strip())
        if norm:
            hmap[col] = norm
    return hmap


def normalise_row(header_map, raw_row):
    mapped = {}
    for orig_col, value in raw_row.items():
        key = header_map.get(orig_col)
        if key:
            mapped[key] = (value or "").strip() if isinstance(value, str) else value
    return mapped


def read_csv(path):
    for enc in ("utf-8-sig", "big5", "cp950"):
        try:
            with open(path, encoding=enc) as f:
                reader = csv.DictReader(f)
                header_map = build_header_map(reader.fieldnames)
                if "district_code" not in header_map.values():
                    continue
                if "x" not in header_map.values() or "y" not in header_map.values():
                    continue
                rows = []
                for raw in reader:
                    rows.append(normalise_row(header_map, raw))
                return rows
        except (UnicodeDecodeError, UnicodeError):
            continue
    for enc in ("big5", "cp950", "utf-8"):
        try:
            with open(path, encoding=enc, errors="replace") as f:
                reader = csv.DictReader(f)
                header_map = build_header_map(reader.fieldnames)
                if "district_code" not in header_map.values():
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
    if "district_code" not in header_map.values():
        wb.close()
        return None
    rows = []
    for raw_values in rows_iter:
        raw_row = dict(zip(header, raw_values))
        rows.append(normalise_row(header_map, raw_row))
    wb.close()
    return rows


def process_rows(rows, city_name, output_base):
    districts = defaultdict(list)

    for row in rows:
        dist = row.get("district_code")
        if not dist:
            continue
        dist = str(dist).strip()
        if not dist:
            continue
        try:
            float(row.get("x", ""))
            float(row.get("y", ""))
        except (ValueError, TypeError):
            continue
        districts[dist].append(row)

    if not districts:
        print(f"  WARNING: no valid data found for {city_name}")
        return

    out_dir = os.path.join(output_base, city_name)
    os.makedirs(out_dir, exist_ok=True)

    total_districts = len(districts)
    total_rows = 0
    for idx, (dist, dist_rows) in enumerate(sorted(districts.items()), 1):
        outpath = os.path.join(out_dir, f"{dist}.csv")
        with open(outpath, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=OUTPUT_COLUMNS, extrasaction="ignore")
            writer.writeheader()
            for row in dist_rows:
                out = {}
                for col in OUTPUT_COLUMNS:
                    val = row.get(col)
                    out[col] = str(val) if val is not None else ""
                writer.writerow(out)
        total_rows += len(dist_rows)
        print(f"  [{idx}/{total_districts}] {dist}: {len(dist_rows)} rows", flush=True)

    print(f"  Total: {total_rows} rows across {total_districts} districts")


def main():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    output_base = os.path.join(base_dir, "data")
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
