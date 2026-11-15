#!/usr/bin/env python3
"""Build a dense, real-road-following Delhi NCR graph for Map Navigator.

Fetches real driving geometries between 48 Delhi NCR landmarks/intersections
across ~90 major road corridors using OSRM, downsamples intermediate road
geometry nodes to ~100-140m spacing, and writes backend/data/delhi_demo_graph.csv.
"""

from __future__ import annotations

import json
import math
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

EARTH_RADIUS_M = 6371000.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2.0) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2.0) ** 2
    )
    return 2.0 * EARTH_RADIUS_M * math.asin(math.sqrt(min(1.0, max(0.0, a))))


# 48 Named Landmarks & Critical Intersections (0..47)
LANDMARKS: list[tuple[int, float, float, str]] = [
    (0, 28.612900, 77.229500, "India Gate"),
    (1, 28.625300, 77.234600, "Mandi House"),
    (2, 28.631500, 77.216700, "Connaught Place"),
    (3, 28.642000, 77.219900, "New Delhi Railway Station"),
    (4, 28.667500, 77.228800, "Kashmere Gate"),
    (5, 28.676900, 77.225500, "Civil Lines"),
    (6, 28.651000, 77.190000, "Karol Bagh"),
    (7, 28.643000, 77.178400, "Rajendra Place"),
    (8, 28.655200, 77.170200, "Patel Nagar"),
    (9, 28.567700, 77.243200, "Lajpat Nagar"),
    (10, 28.549500, 77.251300, "Nehru Place"),
    (11, 28.555300, 77.242900, "Greater Kailash"),
    (12, 28.549400, 77.200100, "Hauz Khas"),
    (13, 28.524500, 77.206600, "Saket"),
    (14, 28.567200, 77.210000, "AIIMS"),
    (15, 28.569400, 77.193000, "Safdarjung"),
    (16, 28.498200, 77.089000, "Cyber City"),
    (17, 28.459500, 77.026600, "Gurugram"),
    (18, 28.556200, 77.100000, "Indira Gandhi International Airport"),
    (19, 28.592100, 77.046000, "Dwarka"),
    (20, 28.570200, 77.324000, "Noida Sector 18"),
    (21, 28.612700, 77.277300, "Akshardham"),
    (22, 28.609500, 77.295000, "Mayur Vihar"),
    (23, 28.655900, 77.241000, "Old Delhi"),
    (24, 28.641700, 77.239000, "Delhi Gate"),
    (25, 28.583000, 77.242500, "Jangpura"),
    (26, 28.572400, 77.259400, "Ashram"),
    (27, 28.520000, 77.150000, "Vasant Kunj"),
    (28, 28.666700, 77.216700, "Tis Hazari"),
    (29, 28.656500, 77.205500, "Rani Jhansi Flyover"),
    (30, 28.644800, 77.211500, "Paharganj"),
    (31, 28.644500, 77.199800, "Jhandewalan"),
    (32, 28.637500, 77.157000, "Pusa Institute"),
    (33, 28.669000, 77.133000, "Punjabi Bagh"),
    (34, 28.691500, 77.151500, "Netaji Subhash Place"),
    (35, 28.716000, 77.118000, "Rohini"),
    (36, 28.688000, 77.210000, "Delhi University"),
    (37, 28.628500, 77.241500, "ITO"),
    (38, 28.656200, 77.238500, "Red Fort"),
    (39, 28.591500, 77.250500, "Nizamuddin"),
    (40, 28.588500, 77.256500, "Sarai Kale Khan"),
    (41, 28.592000, 77.161500, "Dhaula Kuan"),
    (42, 28.578500, 77.175500, "Moti Bagh"),
    (43, 28.545000, 77.192500, "IIT Delhi"),
    (44, 28.546000, 77.125000, "Mahipalpur"),
    (45, 28.535500, 77.272000, "Okhla"),
    (46, 28.630500, 77.277500, "Laxmi Nagar"),
    (47, 28.673000, 77.289000, "Shahdara"),
]

# ~90 Realistic Delhi NCR Road Corridors: (u, v, road_name, speed_kph, direction)
CORRIDORS: list[tuple[int, int, str, int, str]] = [
    # Central & Lutyens Delhi
    (0, 1, "Janpath", 40, "B"),
    (0, 2, "Kasturba Gandhi Marg", 40, "B"),
    (1, 2, "Barakhamba Road", 35, "B"),
    (1, 37, "Deen Dayal Upadhyaya Marg", 40, "B"),
    (37, 24, "Bahadur Shah Zafar Marg", 35, "B"),
    (2, 3, "Chelmsford Road", 30, "B"),
    (2, 24, "Jawaharlal Nehru Marg", 35, "B"),
    (0, 14, "Sri Aurobindo Marg", 45, "B"),
    (0, 25, "Lodhi Road", 45, "B"),
    (0, 39, "Subramania Bharti Marg", 45, "B"),
    (0, 41, "Sardar Patel Marg", 50, "B"),
    (2, 41, "Mother Teresa Crescent", 45, "B"),

    # North & Central-West (Civil Lines / Kashmere Gate / Tis Hazari / Karol Bagh / Rajendra Place)
    (4, 5, "Lala Hardev Sahai Marg", 40, "B"),
    (5, 28, "Rajpur Road", 35, "B"),
    (4, 28, "Boulevard Road", 40, "B"),
    (28, 29, "Rani Jhansi Road", 40, "B"),
    (29, 6, "Rani Jhansi Road", 35, "B"),
    (29, 31, "Faiz Road", 35, "B"),
    (29, 30, "Desh Bandhu Gupta Road", 35, "B"),
    (3, 30, "Desh Bandhu Gupta Road", 30, "B"),
    (30, 31, "Desh Bandhu Gupta Road", 35, "B"),
    (31, 6, "Desh Bandhu Gupta Road", 35, "B"),
    (2, 30, "Panchkuian Road", 35, "B"),
    (2, 31, "Panchkuian Road", 40, "B"),
    (31, 7, "Pusa Road", 40, "B"),
    (6, 7, "Pusa Road", 35, "B"),
    (7, 8, "Patel Road", 40, "B"),
    (7, 32, "Pusa Road", 40, "B"),
    (8, 32, "Loha Mandi Road", 35, "B"),
    (6, 8, "Satguru Ram Singh Marg", 35, "B"),

    # Old Delhi & North Ring
    (24, 23, "Netaji Subhash Marg", 30, "B"),
    (24, 38, "Netaji Subhash Marg", 35, "B"),
    (23, 38, "Chandni Chowk", 25, "B"),
    (38, 4, "Lothian Road", 35, "B"),
    (23, 4, "SP Mukherjee Marg", 30, "B"),
    (3, 24, "Asaf Ali Road", 30, "B"),
    (3, 23, "Shradhanand Marg", 25, "B"),
    (28, 23, "SP Mukherjee Marg", 30, "B"),
    (5, 36, "Mall Road", 40, "B"),
    (28, 36, "Roshanara Road", 35, "B"),

    # North-West (DU / NSP / Punjabi Bagh / Rohini / Patel Nagar)
    (36, 34, "Inner Ring Road", 50, "B"),
    (34, 35, "Outer Ring Road", 50, "B"),
    (34, 33, "Mahatma Gandhi Marg", 50, "B"),
    (33, 35, "Rohtak Road", 45, "B"),
    (8, 33, "Rohtak Road", 40, "B"),
    (29, 34, "Kalidas Marg", 40, "B"),
    (32, 33, "Mahatma Gandhi Marg", 45, "B"),
    (32, 41, "Upper Ridge Road", 45, "B"),
    (7, 41, "Vandemataram Marg", 45, "B"),

    # South-West & Airport / Gurugram / Dwarka
    (41, 42, "Mahatma Gandhi Marg", 50, "B"),
    (42, 15, "Ring Road", 45, "B"),
    (15, 14, "Mahatma Gandhi Marg", 45, "B"),
    (41, 44, "NH 48", 60, "B"),
    (44, 18, "IGI Airport Approach Road", 50, "B"),
    (44, 27, "Abdul Gaffar Khan Marg", 45, "B"),
    (44, 16, "NH 48", 65, "B"),
    (16, 17, "NH 48", 65, "B"),
    (18, 19, "Dwarka Sector Road", 50, "B"),
    (41, 19, "Station Road", 45, "B"),
    (33, 19, "Najafgarh Road", 45, "B"),
    (19, 17, "Dwarka Expressway", 65, "B"),

    # South Delhi (AIIMS / Hauz Khas / IIT / Saket / Vasant Kunj / GK / Nehru Place)
    (15, 12, "Africa Avenue", 40, "B"),
    (15, 43, "Africa Avenue", 40, "B"),
    (14, 12, "Sri Aurobindo Marg", 40, "B"),
    (12, 43, "Outer Ring Road", 45, "B"),
    (43, 27, "Nelson Mandela Marg", 45, "B"),
    (43, 13, "Press Enclave Marg", 40, "B"),
    (12, 13, "Sri Aurobindo Marg", 40, "B"),
    (13, 27, "Mehrauli Badarpur Road", 40, "B"),
    (14, 9, "Mahatma Gandhi Marg", 45, "B"),
    (12, 11, "Outer Ring Road", 45, "B"),
    (9, 11, "Lala Lajpat Rai Marg", 35, "B"),
    (11, 10, "Outer Ring Road", 40, "B"),
    (9, 10, "Lala Lajpat Rai Marg", 40, "B"),
    (10, 13, "Outer Ring Road", 40, "B"),
    (10, 45, "Ma Anandmayee Marg", 40, "B"),

    # South-East & Ring Road (Jangpura / Nizamuddin / Sarai Kale Khan / Ashram / Okhla)
    (25, 39, "Lala Lajpat Rai Marg", 40, "B"),
    (39, 40, "Mahatma Gandhi Marg", 50, "B"),
    (25, 9, "Lala Lajpat Rai Marg", 40, "B"),
    (25, 26, "Mathura Road", 40, "B"),
    (40, 26, "Mahatma Gandhi Marg", 50, "B"),
    (9, 26, "Mahatma Gandhi Marg", 45, "B"),
    (26, 45, "Mathura Road", 45, "B"),
    (37, 39, "Mathura Road", 45, "B"),
    (37, 40, "Mahatma Gandhi Marg", 55, "B"),

    # Trans-Yamuna / East Delhi / Noida
    (37, 46, "Vikas Marg", 45, "B"),
    (46, 21, "NH 9", 50, "B"),
    (21, 40, "Delhi Meerut Expressway", 60, "B"),
    (21, 22, "Noida Link Road", 50, "B"),
    (40, 22, "Noida Link Road", 50, "B"),
    (26, 20, "DND Flyway", 60, "B"),
    (22, 20, "Noida Link Road", 55, "B"),
    (45, 20, "Kalindi Kunj Road", 45, "B"),
    (4, 47, "Grand Trunk Road", 45, "B"),
    (46, 47, "Swami Dayanand Marg", 40, "B"),
]


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dlon = math.radians(lon2 - lon1)
    lat1_r = math.radians(lat1)
    lat2_r = math.radians(lat2)
    y = math.sin(dlon) * math.cos(lat2_r)
    x = math.cos(lat1_r) * math.sin(lat2_r) - math.sin(lat1_r) * math.cos(lat2_r) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def angle_diff_deg(b1: float, b2: float) -> float:
    diff = abs(b1 - b2) % 360.0
    return 360.0 - diff if diff > 180.0 else diff


def trim_uturn_hooks(
    coords: list[tuple[float, float]],
    u_lat: float,
    u_lon: float,
    v_lat: float,
    v_lon: float,
) -> list[tuple[float, float]]:
    """Remove OSRM divided-carriageway U-turn loops near start/end landmarks."""
    if len(coords) <= 2:
        return coords
    direct = haversine_m(u_lat, u_lon, v_lat, v_lon)
    hook_radius = min(300.0, direct * 0.26)
    start_idx = 0
    for i in range(len(coords) - 1):
        if haversine_m(u_lat, u_lon, coords[i][0], coords[i][1]) <= hook_radius:
            start_idx = i
    end_idx = len(coords) - 1
    for i in range(len(coords) - 1, start_idx, -1):
        if haversine_m(v_lat, v_lon, coords[i][0], coords[i][1]) <= hook_radius:
            end_idx = i
    return [(u_lat, u_lon)] + coords[start_idx + 1 : end_idx] + [(v_lat, v_lon)]


def downsample_coords(
    coords: list[tuple[float, float]],
    start_lat: float,
    start_lon: float,
    end_lat: float,
    end_lon: float,
    min_step_m: float = 380.0,
    turn_step_m: float = 115.0,
    turn_angle_deg: float = 24.0,
) -> list[tuple[float, float]]:
    """Snap endpoints to exact landmark coordinates, trim median U-turn hooks,
    and downsample intermediate points while preserving curves and turns."""
    coords = trim_uturn_hooks(coords, start_lat, start_lon, end_lat, end_lon)
    if len(coords) <= 2:
        return [(start_lat, start_lon), (end_lat, end_lon)]

    kept: list[tuple[float, float]] = [(start_lat, start_lon)]
    last_lat, last_lon = start_lat, start_lon
    prev_bearing: float | None = None

    for idx in range(1, len(coords) - 1):
        lat, lon = coords[idx]
        next_lat, next_lon = coords[idx + 1]
        dist_from_last = haversine_m(last_lat, last_lon, lat, lon)
        dist_to_end = haversine_m(lat, lon, end_lat, end_lon)
        if dist_to_end < turn_step_m * 0.8:
            continue

        in_bearing = bearing_deg(last_lat, last_lon, lat, lon)
        out_bearing = bearing_deg(lat, lon, next_lat, next_lon)
        turn = angle_diff_deg(in_bearing, out_bearing)
        if prev_bearing is not None:
            turn = max(turn, angle_diff_deg(prev_bearing, in_bearing))

        if dist_from_last >= min_step_m or (dist_from_last >= turn_step_m and turn >= turn_angle_deg):
            kept.append((lat, lon))
            prev_bearing = bearing_deg(last_lat, last_lon, lat, lon)
            last_lat, last_lon = lat, lon

    kept.append((end_lat, end_lon))
    return kept


def fetch_osrm_corridor(
    corridor_idx: int,
    u_lat: float,
    u_lon: float,
    v_lat: float,
    v_lon: float,
) -> tuple[int, list[tuple[float, float]], bool]:
    """Fetch full driving polyline from OSRM with retries."""
    url = (
        f"https://router.project-osrm.org/route/v1/driving/"
        f"{u_lon:.6f},{u_lat:.6f};{v_lon:.6f},{v_lat:.6f}"
        f"?overview=full&geometries=geojson"
    )
    for attempt in range(4):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "MapNavigator-GraphBuilder/1.0"},
            )
            with urllib.request.urlopen(req, timeout=12) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
                routes = payload.get("routes") or []
                if routes:
                    raw_coords = routes[0]["geometry"]["coordinates"]
                    lat_lon_coords = [(float(c[1]), float(c[0])) for c in raw_coords]
                    return corridor_idx, lat_lon_coords, True
        except Exception:
            time.sleep(0.35 * (attempt + 1))

    # Fallback: interpolate intermediate points if OSRM was unreachable
    dist = haversine_m(u_lat, u_lon, v_lat, v_lon)
    steps = max(2, int(dist // 140.0))
    fallback = [
        (
            u_lat + (v_lat - u_lat) * (i / steps),
            u_lon + (v_lon - u_lon) * (i / steps),
        )
        for i in range(steps + 1)
    ]
    return corridor_idx, fallback, False


def main() -> int:
    landmark_by_id = {lid: (lat, lon, name) for lid, lat, lon, name in LANDMARKS}
    assert len(landmark_by_id) == len(LANDMARKS), "Duplicate landmark IDs"
    assert list(landmark_by_id.keys()) == list(range(len(LANDMARKS))), "Landmark IDs must be 0..K-1"

    print(f"Fetching OSRM road geometry for {len(CORRIDORS)} corridors across {len(LANDMARKS)} landmarks...")
    corridor_geometries: dict[int, list[tuple[float, float]]] = {}
    osrm_ok_count = 0

    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = []
        for idx, (u, v, road_name, speed, direction) in enumerate(CORRIDORS):
            u_lat, u_lon, _ = landmark_by_id[u]
            v_lat, v_lon, _ = landmark_by_id[v]
            futures.append(pool.submit(fetch_osrm_corridor, idx, u_lat, u_lon, v_lat, v_lon))

        for fut in as_completed(futures):
            idx, coords, ok = fut.result()
            corridor_geometries[idx] = coords
            if ok:
                osrm_ok_count += 1

    print(f"OSRM geometry fetched for {osrm_ok_count}/{len(CORRIDORS)} corridors.")

    nodes: list[tuple[int, float, float, str]] = list(LANDMARKS)
    edges: list[tuple[int, int, str, int, str]] = []
    next_node_id = len(LANDMARKS)

    for idx, (u, v, road_name, speed, direction) in enumerate(CORRIDORS):
        u_lat, u_lon, _ = landmark_by_id[u]
        v_lat, v_lon, _ = landmark_by_id[v]
        raw_coords = corridor_geometries[idx]
        sampled = downsample_coords(raw_coords, u_lat, u_lon, v_lat, v_lon)

        chain_ids = [u]
        for lat, lon in sampled[1:-1]:
            nid = next_node_id
            next_node_id += 1
            nodes.append((nid, lat, lon, f"OSM node {nid}"))
            chain_ids.append(nid)
        chain_ids.append(v)

        for a, b in zip(chain_ids, chain_ids[1:]):
            edges.append((a, b, road_name, speed, direction))

    repo_root = Path(__file__).resolve().parents[2]
    out_path = repo_root / "backend" / "data" / "delhi_demo_graph.csv"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with out_path.open("w", encoding="utf-8", newline="\n") as f:
        f.write(
            "# Map Navigator Delhi NCR road graph. Landmarks (0..47) + real OSRM road geometry nodes.\n"
        )
        f.write("# B = bidirectional, F = forward-only.\n")
        f.write("# N|id|latitude|longitude|display name\n")
        for nid, lat, lon, name in nodes:
            f.write(f"N|{nid}|{lat:.6f}|{lon:.6f}|{name}\n")
        f.write("# E|from|to|road name|speed kph|direction\n")
        for u, v, road_name, speed, direction in edges:
            f.write(f"E|{u}|{v}|{road_name}|{speed}|{direction}\n")

    print(f"Wrote {len(nodes)} nodes ({len(LANDMARKS)} landmarks) and {len(edges)} edges to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
