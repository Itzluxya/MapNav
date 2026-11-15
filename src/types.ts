export type Coordinate = {
  latitude: number;
  longitude: number;
  label: string;
};

export type Objective = 'fastest' | 'shortest';

export type AlgorithmId = 'astar' | 'dijkstra' | 'bfs' | 'dfs';

export type Place = Coordinate & { id: number };

export type RouteGeometry = {
  type: 'LineString';
  coordinates: [number, number][];
};

export type Maneuver = {
  instruction: string;
  coordinate: [number, number];
  metersToNext: number;
};

export type RouteResponse = {
  route: {
    objective: Objective;
    algorithmId?: AlgorithmId;
    algorithm: string;
    distanceMeters: number;
    durationSeconds: number;
    visitedNodes: number;
    pathNodes?: number;
    executionMicros?: number;
  };
  geometry: RouteGeometry;
  visitedNodeIds?: number[];
  maneuvers: Maneuver[];
};

export type GraphNode = {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  isLandmark: boolean;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: [number, number][];
};

export type AlgorithmComparison = {
  algorithmId: AlgorithmId;
  algorithm: string;
  distanceMeters: number;
  durationSeconds: number;
  visitedNodes: number;
  pathNodes: number;
  executionMicros: number;
  optimal: boolean;
};
