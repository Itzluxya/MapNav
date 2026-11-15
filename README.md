# MapNav (Map Navigator)

An interactive Delhi NCR route-planning and turn-by-turn navigation web app powered by a custom road-graph routing engine. The browser requests routes from the backend service, receives a road-following GeoJSON polyline with turn-by-turn maneuvers, and renders them on an interactive MapLibre map. Navigation mode watches browser geolocation (with permission), follows the live position marker, and automatically recalculates the route after a meaningful deviation.

## Features

- **Interactive Map UI**: React + TypeScript + MapLibre GL interface supporting map-click origin/destination selection, landmark search, route objectives, distance/ETA display, and step-by-step maneuvers.
- **Custom Routing Engine**: Directed adjacency-list road graph with an in-memory KD-tree for nearest-road snapping, supporting **A\*** (Haversine heuristic) and **Dijkstra** algorithms with a binary min-heap priority queue, parent-vector route reconstruction, and generated turn instructions.
- **Dual Backend Support**:
  - **Node.js HTTP API** (`backend/server.js`) for cross-platform local development and cloud hosting.
  - **C++20 HTTP API** (`backend/src/`) for high-performance native execution.
- **Route Objectives**: `fastest` (edge travel-time) and `shortest` (edge distance).
- **OSM XML Importer**: Python tooling (`backend/tools/osm_to_graph.py`) to convert bounded OpenStreetMap XML extracts into the graph CSV format while retaining drivable roads and one-way rules.
- **Starter & Full Graph Support**: Includes a lightweight demo graph (`backend/data/delhi_demo_graph.csv`) for instant setup; automatically loads `backend/data/delhi_ncr_graph.csv` when present.

## Run Locally

The simplest way to start both the backend API and the Vite frontend is:

```bash
npm install
npm run dev:full
```

Then open `http://127.0.0.1:5173`.

Alternatively, run the backend and frontend in separate terminals:

**Option A — Node.js backend:**
```bash
npm run api
npm run dev
```

**Option B — C++20 backend:**
```bash
make -C backend
./backend/bin/navigator_api
```
Then in another terminal:
```bash
npm run dev
```

The Vite dev server proxies `/api` requests to `http://127.0.0.1:8080`.

## Test the routing API

```bash
curl 'http://127.0.0.1:8080/api/status'
curl 'http://127.0.0.1:8080/api/search?q=India'
curl 'http://127.0.0.1:8080/api/route?fromLat=28.6129&fromLng=77.2295&toLat=28.5702&toLng=77.3240&objective=fastest'
curl 'http://127.0.0.1:8080/api/route?fromLat=28.6129&fromLng=77.2295&toLat=28.5702&toLng=77.3240&objective=fastest&algorithm=dijkstra'
```

The final two commands should return the same optimal distance/duration. A* should normally visit fewer nodes; the frontend intentionally uses A*.

## Graph format and fuller OSM coverage

The server loads `backend/data/delhi_ncr_graph.csv` when present, then falls back to the small `delhi_demo_graph.csv`. The full graph is not bundled in this lightweight repository upload. The format is deliberately simple:

```text
N|internal-id|latitude|longitude|display name
E|from-id|to-id|road name|speed-kph|B-or-F
```

`B` produces two directed edges; `F` preserves a one-way edge. For a larger dataset, obtain a bounded OSM **XML** extract from a source whose terms allow it, then run:

```bash
python3 backend/tools/osm_to_graph.py /path/to/delhi.osm backend/data/delhi_graph.csv
NAVIGATOR_GRAPH=backend/data/delhi_graph.csv ./backend/bin/navigator_api
```

The importer purposefully does not bulk-download data from public OSM services. The bundled full graph is a one-time, bounded import. The API uses an in-memory KD-tree for nearest-road snapping. Before calling the large-city version production-ready, add turn-restriction relations and a production tile/geocoding provider.

## Map and provider notes

MapLibre renders the map; it is not the routing provider. The bundled demo uses OpenStreetMap raster tiles only for normal interactive development. Preserve visible attribution and do not bulk-prefetch or scrape those public tiles. Public Nominatim should not be used for client-side autocomplete; replace the local landmark search with a properly configured geocoding-provider adapter for broader place search.

## Project layout

```text
src/                    React + TypeScript + MapLibre navigation UI
api/[...slug].js        Vercel Serverless Function entrypoint for /api/*
backend/app.js          Shared Node.js road-graph routing engine & HTTP handler
backend/server.js       Local Node.js HTTP server wrapper
backend/src/            C++20 graph, routing algorithms (A* / Dijkstra), and HTTP API
backend/data/           Runnable Delhi NCR starter graph
backend/tools/          OSM XML to graph converter scripts
scripts/dev-full.mjs    Combined backend + Vite dev launcher
vercel.json             Vercel serverless function bundling config
```
