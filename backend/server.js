import http from 'http';
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const kHeuristicFastestSpeedMps = 45.0 / 3.6;
const kMaximumSnapDistanceMeters = 3000.0;
const kMetersPerDegreeLat = 111132.0;
const kMetersPerDegreeLng = 111320.0 * Math.cos((28.6139 * Math.PI) / 180.0);

const ALGORITHM_NAMES = {
  astar: 'A*',
  dijkstra: 'Dijkstra',
  bfs: 'BFS',
  dfs: 'DFS',
};

function parseAlgorithm(raw) {
  const val = (raw || '').toLowerCase();
  if (val === 'dijkstra') return 'dijkstra';
  if (val === 'bfs') return 'bfs';
  if (val === 'dfs') return 'dfs';
  return 'astar';
}

function haversineMeters(first, second) {
  const earthRadiusMeters = 6371000.0;
  const toRad = Math.PI / 180.0;
  const latDelta = (second.latitude - first.latitude) * toRad;
  const lonDelta = (second.longitude - first.longitude) * toRad;
  const lat1 = first.latitude * toRad;
  const lat2 = second.latitude * toRad;
  const a = Math.sin(latDelta / 2.0) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * (Math.sin(lonDelta / 2.0) ** 2);
  return earthRadiusMeters * 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
}

function bearingDegrees(from, to) {
  const toRad = Math.PI / 180.0;
  const lat1 = from.latitude * toRad;
  const lat2 = to.latitude * toRad;
  const lonDelta = (to.longitude - from.longitude) * toRad;
  const y = Math.sin(lonDelta) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
            Math.sin(lat1) * Math.cos(lat2) * Math.cos(lonDelta);
  return ((Math.atan2(y, x) * 180.0 / Math.PI) + 360.0) % 360.0;
}

function heading(bearing) {
  const labels = ["north", "north-east", "east", "south-east",
                  "south", "south-west", "west", "north-west"];
  const index = Math.floor((bearing + 22.5) / 45.0) % labels.length;
  return labels[index];
}

function angleDifferenceDegrees(previousBearing, nextBearing) {
  return ((nextBearing - previousBearing + 540.0) % 360.0) - 180.0;
}

function turnDescription(previousBearing, nextBearing) {
  const difference = angleDifferenceDegrees(previousBearing, nextBearing);
  if (Math.abs(difference) < 28.0) return "Continue";
  return difference > 0 ? "Turn right" : "Turn left";
}

class RoadGraph {
  constructor() {
    this.nodes = [];
    this.adjacency = [];
    this.edgeCount = 0;
    this.kdTree = null;
    this.xMeters = new Float64Array(0);
    this.yMeters = new Float64Array(0);
  }

  loadCsv(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Graph file not found: ${filePath}`);
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    this.nodes = [];
    this.adjacency = [];
    this.edgeCount = 0;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const fields = line.split('|');

      if (fields[0] === 'N' && fields.length >= 5) {
        const id = parseInt(fields[1], 10);
        if (id !== this.nodes.length) {
          throw new Error(`Node identifiers must be sequential: expected ${this.nodes.length}, got ${id}`);
        }
        const latitude = parseFloat(fields[2]);
        const longitude = parseFloat(fields[3]);
        const isLandmark = !fields[4].startsWith('OSM node ');
        this.nodes.push({
          id,
          point: {
            latitude,
            longitude,
          },
          name: fields[4],
          isLandmark,
        });
        this.adjacency.push([]);
      } else if (fields[0] === 'E' && fields.length >= 6) {
        const from = parseInt(fields[1], 10);
        const to = parseInt(fields[2], 10);
        const roadName = fields[3];
        const speedKph = Math.max(5.0, parseFloat(fields[4]));
        const bidirectional = fields[5] !== 'F';

        if (from >= this.nodes.length || to >= this.nodes.length) {
          throw new Error('Edge references an unknown node');
        }

        const meters = haversineMeters(this.nodes[from].point, this.nodes[to].point);
        const seconds = meters / (speedKph / 3.6);

        const addDirectedEdge = (origin, dest) => {
          this.adjacency[origin].push({
            to: dest,
            meters,
            seconds,
            road_name: roadName,
          });
          if (this.nodes[origin].name.startsWith('OSM node ')) this.nodes[origin].name = roadName;
          if (this.nodes[dest].name.startsWith('OSM node ')) this.nodes[dest].name = roadName;
          this.edgeCount++;
        };

        addDirectedEdge(from, to);
        if (bidirectional) {
          addDirectedEdge(to, from);
        }
      }
    }

    this.xMeters = new Float64Array(this.nodes.length);
    this.yMeters = new Float64Array(this.nodes.length);
    for (let i = 0; i < this.nodes.length; i++) {
      this.xMeters[i] = this.nodes[i].point.longitude * kMetersPerDegreeLng;
      this.yMeters[i] = this.nodes[i].point.latitude * kMetersPerDegreeLat;
    }

    this.buildKdTree();
  }

  buildKdTree() {
    const indices = this.nodes.map((_, i) => i);
    const build = (idxList, depth) => {
      if (idxList.length === 0) return null;
      const splitLat = depth % 2 === 0;
      idxList.sort((a, b) => {
        return splitLat
          ? this.nodes[a].point.latitude - this.nodes[b].point.latitude
          : this.nodes[a].point.longitude - this.nodes[b].point.longitude;
      });
      const mid = Math.floor(idxList.length / 2);
      return {
        graphIndex: idxList[mid],
        splitLat,
        left: build(idxList.slice(0, mid), depth + 1),
        right: build(idxList.slice(mid + 1), depth + 1),
      };
    };
    this.kdTree = build(indices, 0);
  }

  nearestNode(point) {
    if (!this.kdTree || this.nodes.length === 0) return { nearest: -1, distance: Infinity };
    let best = -1;
    let bestDist = Infinity;
    const toRad = Math.PI / 180.0;

    const search = (treeNode) => {
      if (!treeNode) return;
      const currPoint = this.nodes[treeNode.graphIndex].point;
      const dist = haversineMeters(point, currPoint);
      if (dist < bestDist) {
        bestDist = dist;
        best = treeNode.graphIndex;
      }

      const delta = treeNode.splitLat
        ? point.latitude - currPoint.latitude
        : point.longitude - currPoint.longitude;

      const near = delta < 0 ? treeNode.left : treeNode.right;
      const far = delta < 0 ? treeNode.right : treeNode.left;

      search(near);

      const metersPerDegree = treeNode.splitLat
        ? 111132.0
        : 111320.0 * Math.cos(point.latitude * toRad);

      if (Math.abs(delta) * metersPerDegree < bestDist) {
        search(far);
      }
    };

    search(this.kdTree);
    return { nearest: best, distance: bestDist };
  }

  edgeBetween(from, to, objective = 'fastest') {
    const edges = this.adjacency[from] || [];
    let best = null;
    for (const e of edges) {
      if (e.to !== to) continue;
      if (!best) {
        best = e;
      } else if (objective === 'shortest' ? e.meters < best.meters : e.seconds < best.seconds) {
        best = e;
      }
    }
    return best;
  }
}

class MinPriorityQueue {
  constructor() {
    this.scores = new Float64Array(8192);
    this.items = new Int32Array(8192);
    this.size = 0;
  }
  clear() {
    this.size = 0;
  }
  push(score, item) {
    let i = this.size++;
    const scores = this.scores;
    const items = this.items;
    scores[i] = score;
    items[i] = item;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (scores[i] < scores[p]) {
        const tmpS = scores[i];
        scores[i] = scores[p];
        scores[p] = tmpS;
        const tmpI = items[i];
        items[i] = items[p];
        items[p] = tmpI;
        i = p;
      } else break;
    }
  }
  popItem() {
    const items = this.items;
    const scores = this.scores;
    const topItem = items[0];
    const last = --this.size;
    if (last > 0) {
      scores[0] = scores[last];
      items[0] = items[last];
      let i = 0;
      while ((i << 1) + 1 < last) {
        let left = (i << 1) + 1;
        let right = left + 1;
        let smallest = left;
        if (right < last && scores[right] < scores[left]) {
          smallest = right;
        }
        if (scores[smallest] < scores[i]) {
          const tmpS = scores[i];
          scores[i] = scores[smallest];
          scores[smallest] = tmpS;
          const tmpI = items[i];
          items[i] = items[smallest];
          items[smallest] = tmpI;
          i = smallest;
        } else break;
      }
    }
    return topItem;
  }
}

class Router {
  constructor(graph) {
    this.graph = graph;
    this.frontier = new MinPriorityQueue();
  }

  heuristic(from, to, objective) {
    const dx = this.graph.xMeters[from] - this.graph.xMeters[to];
    const dy = this.graph.yMeters[from] - this.graph.yMeters[to];
    const meters = Math.sqrt(dx * dx + dy * dy);
    return objective === 'shortest' ? meters : meters / kHeuristicFastestSpeedMps;
  }

  findRoute(origin, destination, objective = 'fastest', algorithm = 'astar') {
    const startSnap = this.graph.nearestNode(origin);
    const goalSnap = this.graph.nearestNode(destination);

    if (startSnap.nearest < 0 || goalSnap.nearest < 0) {
      return { found: false, error: 'The routing graph is unavailable' };
    }

    if (startSnap.distance > kMaximumSnapDistanceMeters || goalSnap.distance > kMaximumSnapDistanceMeters) {
      return { found: false, error: 'One or both points are outside the loaded Delhi NCR road coverage' };
    }

    const start = startSnap.nearest;
    const goal = goalSnap.nearest;
    const nodeCount = this.graph.nodes.length;
    const bestCost = new Float64Array(nodeCount);
    bestCost.fill(Infinity);
    const parent = new Int32Array(nodeCount);
    parent.fill(-1);
    const seenVisited = new Uint8Array(nodeCount);
    const visitedNodeIds = [];

    let visitedNodes = 0;
    bestCost[start] = 0.0;

    const startTime = performance.now();

    if (algorithm === 'dfs') {
      const stack = [start];
      while (stack.length > 0) {
        const current = stack.pop();
        if (seenVisited[current]) continue;
        seenVisited[current] = 1;
        visitedNodes++;
        visitedNodeIds.push(current);
        if (current === goal) break;

        const edges = this.graph.adjacency[current] || [];
        for (const edge of edges) {
          if (!seenVisited[edge.to]) {
            const dist = haversineMeters(this.graph.nodes[current].point, this.graph.nodes[edge.to].point);
            parent[edge.to] = current;
            bestCost[edge.to] = bestCost[current] + dist;
            stack.push(edge.to);
          }
        }
      }
    } else if (algorithm === 'bfs') {
      const fifo = [start];
      seenVisited[start] = 1;

      while (fifo.length > 0) {
        const current = fifo.shift();
        visitedNodes++;
        visitedNodeIds.push(current);
        if (current === goal) break;

        const edges = this.graph.adjacency[current] || [];
        for (const edge of edges) {
          if (!seenVisited[edge.to]) {
            seenVisited[edge.to] = 1;
            const dist = haversineMeters(this.graph.nodes[current].point, this.graph.nodes[edge.to].point);
            bestCost[edge.to] = bestCost[current] + dist;
            parent[edge.to] = current;
            fifo.push(edge.to);
          }
        }
      }
    } else if (algorithm === 'astar') {
      const frontier = this.frontier;
      frontier.clear();
      const shortest = objective === 'shortest';
      const xMeters = this.graph.xMeters;
      const yMeters = this.graph.yMeters;
      const goalX = xMeters[goal];
      const goalY = yMeters[goal];
      const scale = shortest ? 1.0 : 1.0 / kHeuristicFastestSpeedMps;

      const startDx = xMeters[start] - goalX;
      const startDy = yMeters[start] - goalY;
      frontier.push(Math.sqrt(startDx * startDx + startDy * startDy) * scale, start);

      while (frontier.size > 0) {
        const current = frontier.popItem();
        if (seenVisited[current]) continue;
        seenVisited[current] = 1;
        visitedNodes++;
        visitedNodeIds.push(current);
        if (current === goal) break;

        const currCost = bestCost[current];
        const edges = this.graph.adjacency[current];
        for (let i = 0; i < edges.length; i++) {
          const edge = edges[i];
          const to = edge.to;
          if (seenVisited[to]) continue;
          const weight = shortest ? edge.meters : edge.seconds;
          const tentativeCost = currCost + weight;
          if (tentativeCost + 1e-6 < bestCost[to]) {
            bestCost[to] = tentativeCost;
            parent[to] = current;
            const dx = xMeters[to] - goalX;
            const dy = yMeters[to] - goalY;
            frontier.push(tentativeCost + Math.sqrt(dx * dx + dy * dy) * scale, to);
          }
        }
      }
    } else {
      const frontier = this.frontier;
      frontier.clear();
      const shortest = objective === 'shortest';
      frontier.push(0.0, start);

      while (frontier.size > 0) {
        const current = frontier.popItem();
        if (seenVisited[current]) continue;
        seenVisited[current] = 1;
        visitedNodes++;
        visitedNodeIds.push(current);
        if (current === goal) break;

        const currCost = bestCost[current];
        const edges = this.graph.adjacency[current];
        for (let i = 0; i < edges.length; i++) {
          const edge = edges[i];
          const to = edge.to;
          if (seenVisited[to]) continue;
          const weight = shortest ? edge.meters : edge.seconds;
          const tentativeCost = currCost + weight;
          if (tentativeCost + 1e-6 < bestCost[to]) {
            bestCost[to] = tentativeCost;
            parent[to] = current;
            frontier.push(tentativeCost, to);
          }
        }
      }
    }

    const executionMicros = (performance.now() - startTime) * 1000.0;

    if (!isFinite(bestCost[goal])) {
      return { found: false, error: 'No legal road route connects these points' };
    }

    const nodePath = [];
    for (let curr = goal; curr !== -1; curr = parent[curr]) {
      nodePath.push(curr);
    }
    nodePath.reverse();

    let totalMeters = 0;
    let totalSeconds = 0;
    for (let i = 1; i < nodePath.length; i++) {
      const edge = this.graph.edgeBetween(nodePath[i - 1], nodePath[i], objective);
      if (!edge) {
        return { found: false, error: 'Route reconstruction failed' };
      }
      totalMeters += edge.meters;
      totalSeconds += edge.seconds;
    }

    const maneuvers = this.makeManeuvers(nodePath, objective);

    return {
      found: true,
      nodePath,
      maneuvers,
      visitedNodeIds,
      meters: totalMeters,
      seconds: totalSeconds,
      visitedNodes,
      executionMicros,
      algorithm,
    };
  }

  makeManeuvers(path, objective = 'fastest') {
    const maneuvers = [];
    if (path.length === 0) return maneuvers;
    if (path.length === 1) {
      maneuvers.push({
        instruction: 'You have arrived',
        coordinate: [this.graph.nodes[path[0]].point.longitude, this.graph.nodes[path[0]].point.latitude],
        metersToNext: 0.0,
      });
      return maneuvers;
    }

    const firstEdge = this.graph.edgeBetween(path[0], path[1], objective);
    const firstBearing = bearingDegrees(this.graph.nodes[path[0]].point, this.graph.nodes[path[1]].point);
    maneuvers.push({
      instruction: `Head ${heading(firstBearing)} on ${firstEdge.road_name}`,
      coordinate: [this.graph.nodes[path[0]].point.longitude, this.graph.nodes[path[0]].point.latitude],
      metersToNext: firstEdge.meters,
    });

    for (let i = 1; i + 1 < path.length; i++) {
      const prevEdge = this.graph.edgeBetween(path[i - 1], path[i], objective);
      const nextEdge = this.graph.edgeBetween(path[i], path[i + 1], objective);

      if (prevEdge.road_name !== nextEdge.road_name) {
        const prevBearing = bearingDegrees(this.graph.nodes[path[i - 1]].point, this.graph.nodes[path[i]].point);
        const nextBearing = bearingDegrees(this.graph.nodes[path[i]].point, this.graph.nodes[path[i + 1]].point);
        maneuvers.push({
          instruction: `${turnDescription(prevBearing, nextBearing)} onto ${nextEdge.road_name}`,
          coordinate: [this.graph.nodes[path[i]].point.longitude, this.graph.nodes[path[i]].point.latitude],
          metersToNext: nextEdge.meters,
        });
      } else {
        maneuvers[maneuvers.length - 1].metersToNext += nextEdge.meters;
      }
    }

    const lastNode = this.graph.nodes[path[path.length - 1]];
    maneuvers.push({
      instruction: `Arrive at ${lastNode.name}`,
      coordinate: [lastNode.point.longitude, lastNode.point.latitude],
      metersToNext: 0.0,
    });

    return maneuvers;
  }

  compareRoutes(origin, destination, objective = 'fastest') {
    const runBenchmark = (algo) => {
      let result = null;
      for (let w = 0; w < 2; w++) {
        result = this.findRoute(origin, destination, objective, algo);
        if (!result.found) return result;
      }
      const samples = [];
      for (let run = 0; run < 7; run++) {
        const sample = this.findRoute(origin, destination, objective, algo);
        samples.push(sample.executionMicros);
      }
      samples.sort((a, b) => a - b);
      result.executionMicros = samples[1];
      return result;
    };

    const dijkstraRoute = runBenchmark('dijkstra');
    if (!dijkstraRoute.found) {
      return { found: false, error: dijkstraRoute.error };
    }
    const astarRoute = runBenchmark('astar');
    const bfsRoute = runBenchmark('bfs');
    const dfsRoute = runBenchmark('dfs');

    const optimalCost = objective === 'shortest' ? dijkstraRoute.meters : dijkstraRoute.seconds;
    const tolerance = Math.max(1.0, optimalCost * 0.005);

    const comparisons = [astarRoute, dijkstraRoute, bfsRoute, dfsRoute].map((r) => {
      const cost = objective === 'shortest' ? r.meters : r.seconds;
      const optimal = Boolean(r.found && Math.abs(cost - optimalCost) <= tolerance);
      return {
        algorithmId: r.algorithm,
        algorithm: ALGORITHM_NAMES[r.algorithm] || 'A*',
        distanceMeters: Math.round(r.meters * 10) / 10,
        durationSeconds: Math.round(r.seconds * 10) / 10,
        visitedNodes: r.visitedNodes,
        pathNodes: r.nodePath.length,
        executionMicros: Math.round(r.executionMicros * 10) / 10,
        optimal,
      };
    });

    return { found: true, comparisons };
  }
}

function locateGraph() {
  if (process.env.NAVIGATOR_GRAPH) return process.env.NAVIGATOR_GRAPH;
  const candidates = [
    path.join(__dirname, 'data', 'delhi_ncr_graph.csv'),
    path.join(__dirname, 'data', 'delhi_demo_graph.csv'),
    path.join(__dirname, '..', 'backend', 'data', 'delhi_ncr_graph.csv'),
    path.join(__dirname, '..', 'backend', 'data', 'delhi_demo_graph.csv'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[1];
}

const graph = new RoadGraph();
const graphPath = locateGraph();
console.log(`[Router API] Loading graph from ${graphPath}...`);
graph.loadCsv(graphPath);
console.log(`[Router API] Graph loaded: ${graph.nodes.length} nodes, ${graph.edgeCount} directed edges.`);

const router = new Router(graph);
if (graph.nodes.length >= 2) {
  const p0 = { latitude: 28.6429, longitude: 77.2191 };
  const p1 = { latitude: 28.5494, longitude: 77.2519 };
  for (let i = 0; i < 6; i++) {
    router.compareRoutes(p0, p1, 'fastest');
    router.compareRoutes(p0, p1, 'shortest');
  }
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const params = reqUrl.searchParams;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const sendJson = (status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(body);
    }
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(400, { error: 'Only GET, HEAD, and OPTIONS requests are supported' });
    return;
  }

  if (pathname === '/api/status') {
    sendJson(200, {
      status: 'ok',
      engine: 'C++ A* routing',
      graph: {
        nodes: graph.nodes.length,
        directedEdges: graph.edgeCount,
      },
    });
    return;
  }

  if (pathname === '/api/graph') {
    const nodes = graph.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      latitude: n.point.latitude,
      longitude: n.point.longitude,
      isLandmark: Boolean(n.isLandmark),
    }));
    const edges = [];
    const seenEdges = new Set();
    for (let u = 0; u < graph.nodes.length; u++) {
      const adj = graph.adjacency[u] || [];
      for (const e of adj) {
        const a = Math.min(u, e.to);
        const b = Math.max(u, e.to);
        const key = `${a}:${b}`;
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        edges.push([a, b]);
      }
    }
    sendJson(200, { nodes, edges });
    return;
  }

  if (pathname === '/api/search') {
    const q = (params.get('q') || '').toLowerCase();
    const results = [];
    const seenNames = new Set();
    for (let i = 0; i < graph.nodes.length && results.length < 15; i++) {
      const node = graph.nodes[i];
      if (!node.isLandmark) continue;
      const lowerName = node.name.toLowerCase();
      if (q && !lowerName.includes(q)) continue;
      if (seenNames.has(lowerName)) continue;
      seenNames.add(lowerName);
      results.push({
        id: node.id,
        name: node.name,
        latitude: node.point.latitude,
        longitude: node.point.longitude,
      });
    }
    sendJson(200, { results });
    return;
  }

  if (pathname === '/api/route' || pathname === '/api/compare') {
    const fromLat = parseFloat(params.get('fromLat'));
    const fromLng = parseFloat(params.get('fromLng'));
    const toLat = parseFloat(params.get('toLat'));
    const toLng = parseFloat(params.get('toLng'));

    if (isNaN(fromLat) || isNaN(fromLng) || isNaN(toLat) || isNaN(toLng)) {
      sendJson(400, { error: 'Origin and destination coordinates are required' });
      return;
    }

    if (fromLat < -90 || fromLat > 90 || toLat < -90 || toLat > 90 ||
        fromLng < -180 || fromLng > 180 || toLng < -180 || toLng > 180) {
      sendJson(400, { error: 'Coordinates are outside their valid ranges' });
      return;
    }

    const objective = params.get('objective') === 'shortest' ? 'shortest' : 'fastest';
    const origin = { latitude: fromLat, longitude: fromLng };
    const destination = { latitude: toLat, longitude: toLng };

    if (pathname === '/api/compare') {
      const cmp = router.compareRoutes(origin, destination, objective);
      if (!cmp.found) {
        sendJson(400, { error: cmp.error });
        return;
      }
      sendJson(200, { comparisons: cmp.comparisons });
      return;
    }

    const algorithm = parseAlgorithm(params.get('algorithm'));
    const route = router.findRoute(origin, destination, objective, algorithm);

    if (!route.found) {
      sendJson(400, { error: route.error });
      return;
    }

    const coordinates = route.nodePath.map((idx) => [
      graph.nodes[idx].point.longitude,
      graph.nodes[idx].point.latitude,
    ]);

    const payload = {
      route: {
        objective,
        algorithm: ALGORITHM_NAMES[route.algorithm] || 'A*',
        algorithmId: route.algorithm,
        distanceMeters: Math.round(route.meters * 10) / 10,
        durationSeconds: Math.round(route.seconds * 10) / 10,
        visitedNodes: route.visitedNodes,
        pathNodes: route.nodePath.length,
        executionMicros: Math.round(route.executionMicros * 10) / 10,
      },
      geometry: {
        type: 'LineString',
        coordinates,
      },
      maneuvers: route.maneuvers.map((m) => ({
        instruction: m.instruction,
        coordinate: m.coordinate,
        metersToNext: Math.round(m.metersToNext * 10) / 10,
      })),
      visitedNodeIds: route.visitedNodeIds,
    };

    sendJson(200, payload);
    return;
  }

  sendJson(404, { error: 'Endpoint not found' });
});

const PORT = parseInt(process.env.PORT || '8080', 10);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Router API] Server listening on http://127.0.0.1:${PORT}`);
});
