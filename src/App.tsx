import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map, MapMouseEvent, Marker } from 'maplibre-gl';
import {
  ArrowDownUp,
  ChevronRight,
  LocateFixed,
  MapPin,
  Navigation,
  TriangleAlert,
  X,
} from 'lucide-react';
import { compareAlgorithms, getGraph, getRoute, searchPlaces } from './api';
import type {
  AlgorithmComparison,
  AlgorithmId,
  Coordinate,
  GraphData,
  GraphNode,
  Maneuver,
  Objective,
  Place,
  RouteResponse,
} from './types';

const INDIA_GATE: Coordinate = { latitude: 28.6129, longitude: 77.2295, label: 'India Gate' };
const CONNAUGHT_PLACE: Coordinate = { latitude: 28.6315, longitude: 77.2167, label: 'Connaught Place' };

const ALGORITHM_OPTIONS: Array<{ id: AlgorithmId; label: string }> = [
  { id: 'astar', label: 'A*' },
  { id: 'dijkstra', label: 'Dijkstra' },
  { id: 'bfs', label: 'BFS' },
  { id: 'dfs', label: 'DFS' },
];

const emptyFeatureCollection = {
  type: 'FeatureCollection' as const,
  features: [],
};

function asRouteFeatureCollection(route: RouteResponse | null) {
  if (!route) return emptyFeatureCollection;
  return {
    type: 'FeatureCollection' as const,
    features: [{ type: 'Feature' as const, properties: {}, geometry: route.geometry }],
  };
}

function buildGraphGeoJSON(graphData: GraphData | null) {
  if (!graphData) {
    return {
      edges: emptyFeatureCollection,
      waypoints: emptyFeatureCollection,
      landmarks: emptyFeatureCollection,
    };
  }
  const nodeById = new globalThis.Map<number, GraphNode>();
  for (const node of graphData.nodes) {
    nodeById.set(node.id, node);
  }

  const edgeFeatures = [];
  for (const [u, v] of graphData.edges) {
    const fromNode = nodeById.get(u);
    const toNode = nodeById.get(v);
    if (!fromNode || !toNode) continue;
    edgeFeatures.push({
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [fromNode.longitude, fromNode.latitude],
          [toNode.longitude, toNode.latitude],
        ],
      },
    });
  }

  const waypointFeatures = [];
  const landmarkFeatures = [];
  for (const node of graphData.nodes) {
    const feature = {
      type: 'Feature' as const,
      properties: {
        id: node.id,
        name: node.name,
        latitude: node.latitude,
        longitude: node.longitude,
        isLandmark: node.isLandmark,
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [node.longitude, node.latitude],
      },
    };
    if (node.isLandmark) {
      landmarkFeatures.push(feature);
    } else {
      waypointFeatures.push(feature);
    }
  }

  return {
    edges: { type: 'FeatureCollection' as const, features: edgeFeatures },
    waypoints: { type: 'FeatureCollection' as const, features: waypointFeatures },
    landmarks: { type: 'FeatureCollection' as const, features: landmarkFeatures },
  };
}

function buildVisitedGeoJSON(graphData: GraphData | null, visitedNodeIds: number[] | undefined) {
  if (!graphData || !visitedNodeIds?.length) return emptyFeatureCollection;
  const visitedSet = new Set(visitedNodeIds);
  const features = graphData.nodes
    .filter((node) => visitedSet.has(node.id))
    .map((node) => ({
      type: 'Feature' as const,
      properties: {
        id: node.id,
        name: node.name,
        latitude: node.latitude,
        longitude: node.longitude,
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [node.longitude, node.latitude],
      },
    }));
  return {
    type: 'FeatureCollection' as const,
    features,
  };
}

function formatDistance(meters: number) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 1)} km` : `${Math.round(meters)} m`;
}

function formatDuration(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : `${minutes} min`;
}

function formatMicros(micros: number) {
  if (micros < 1000) return `${Math.max(1, Math.round(micros))} µs`;
  return `${(micros / 1000).toFixed(2)} ms`;
}

function haversineMeters(first: Coordinate, second: Coordinate) {
  const radians = Math.PI / 180;
  const latitudeDelta = (second.latitude - first.latitude) * radians;
  const longitudeDelta = (second.longitude - first.longitude) * radians;
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(first.latitude * radians) * Math.cos(second.latitude * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pointToSegmentMeters(point: Coordinate, start: [number, number], end: [number, number]) {
  const radians = Math.PI / 180;
  const earthRadius = 6_371_000;
  const cosLat = Math.cos(point.latitude * radians);
  const ax = (start[0] - point.longitude) * radians * earthRadius * cosLat;
  const ay = (start[1] - point.latitude) * radians * earthRadius;
  const bx = (end[0] - point.longitude) * radians * earthRadius * cosLat;
  const by = (end[1] - point.latitude) * radians * earthRadius;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq)) : 0;
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return Math.hypot(projX, projY);
}

function distanceToRoute(point: Coordinate, route: RouteResponse | null) {
  const coords = route?.geometry.coordinates;
  if (!coords?.length) return Infinity;
  if (coords.length === 1) {
    return haversineMeters(point, { latitude: coords[0][1], longitude: coords[0][0], label: '' });
  }
  let minDistance = Infinity;
  for (let i = 0; i < coords.length - 1; i += 1) {
    const segmentDistance = pointToSegmentMeters(point, coords[i], coords[i + 1]);
    if (segmentDistance < minDistance) {
      minDistance = segmentDistance;
    }
  }
  return minDistance;
}

type FieldName = 'origin' | 'destination';

function mapStyle() {
  return {
    version: 8 as const,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      osm: {
        type: 'raster' as const,
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [{ id: 'osm', type: 'raster' as const, source: 'osm' }],
  };
}

export function App() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const routeInputsRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const originMarker = useRef<Marker | null>(null);
  const destinationMarker = useRef<Marker | null>(null);
  const userMarker = useRef<Marker | null>(null);
  const routeRef = useRef<RouteResponse | null>(null);
  const activeFieldRef = useRef<FieldName>('origin');
  const watchIdRef = useRef<number | null>(null);
  const searchControllerRef = useRef<AbortController | null>(null);
  const lastFittedEndpointsRef = useRef<string>('');

  const [origin, setOrigin] = useState<Coordinate>(INDIA_GATE);
  const [destination, setDestination] = useState<Coordinate>(CONNAUGHT_PLACE);
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [objective, setObjective] = useState<Objective>('fastest');
  const [algorithm, setAlgorithm] = useState<AlgorithmId>('astar');
  const [comparisons, setComparisons] = useState<AlgorithmComparison[]>([]);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [showNodes, setShowNodes] = useState(true);
  const [showVisited, setShowVisited] = useState(true);
  const [activeField, setActiveField] = useState<FieldName>('origin');
  const [isEditingSearch, setIsEditingSearch] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [suggestions, setSuggestions] = useState<Place[]>([]);
  const [loadingRoute, setLoadingRoute] = useState(true);
  const [routeError, setRouteError] = useState('');
  const [isNavigating, setIsNavigating] = useState(false);
  const [liveLocation, setLiveLocation] = useState<Coordinate | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    activeFieldRef.current = activeField;
  }, [activeField]);

  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  const closeSearch = useCallback(() => {
    searchControllerRef.current?.abort();
    searchControllerRef.current = null;
    setIsEditingSearch(false);
    setSearchText('');
    setSuggestions([]);
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (routeInputsRef.current && !routeInputsRef.current.contains(event.target as Node)) {
        closeSearch();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeSearch();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeSearch]);

  const putPoint = useCallback((field: FieldName, point: Coordinate) => {
    if (field === 'origin') setOrigin(point);
    else setDestination(point);
    searchControllerRef.current?.abort();
    searchControllerRef.current = null;
    setIsEditingSearch(false);
    setSearchText('');
    setSuggestions([]);
    setActiveField(field === 'origin' ? 'destination' : field);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getGraph(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setGraphData(data);
        }
      })
      .catch(() => {
        // Graph overlay is optional if backend is unreachable
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: mapStyle(),
      center: [77.2167, 28.622],
      zoom: 11.4,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 96, unit: 'metric' }), 'bottom-left');
    map.on('load', () => {
      map.addSource('graph-edges', { type: 'geojson', data: emptyFeatureCollection });
      map.addSource('graph-waypoints', { type: 'geojson', data: emptyFeatureCollection });
      map.addSource('visited-nodes', { type: 'geojson', data: emptyFeatureCollection });
      map.addSource('route', { type: 'geojson', data: emptyFeatureCollection });
      map.addSource('landmark-nodes', { type: 'geojson', data: emptyFeatureCollection });

      map.addLayer({
        id: 'graph-edges-layer',
        type: 'line',
        source: 'graph-edges',
        paint: {
          'line-color': '#475569',
          'line-width': 1.25,
          'line-opacity': 0.45,
        },
      });

      map.addLayer({
        id: 'graph-waypoints-layer',
        type: 'circle',
        source: 'graph-waypoints',
        paint: {
          'circle-radius': 2.5,
          'circle-color': '#64748b',
          'circle-opacity': 0.65,
        },
      });

      map.addLayer({
        id: 'visited-nodes-layer',
        type: 'circle',
        source: 'visited-nodes',
        paint: {
          'circle-radius': 4.5,
          'circle-color': '#f59e0b',
          'circle-stroke-width': 1,
          'circle-stroke-color': '#0b0d14',
          'circle-opacity': 0.88,
        },
      });

      map.addLayer({
        id: 'route-outline',
        type: 'line',
        source: 'route',
        paint: { 'line-color': '#0b0d14', 'line-width': 8, 'line-opacity': 0.85 },
      });

      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        paint: { 'line-color': '#3b82f6', 'line-width': 4, 'line-opacity': 1 },
      });

      map.addLayer({
        id: 'landmark-nodes-layer',
        type: 'circle',
        source: 'landmark-nodes',
        paint: {
          'circle-radius': 5.5,
          'circle-color': '#11141c',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#eef0f5',
        },
      });

      map.addLayer({
        id: 'landmark-labels-layer',
        type: 'symbol',
        source: 'landmark-nodes',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Semibold'],
          'text-size': 11,
          'text-offset': [0, 0.85],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: {
          'text-color': '#0b0d14',
          'text-halo-color': 'rgba(255, 255, 255, 0.92)',
          'text-halo-width': 1.5,
        },
      });

      for (const layerId of ['landmark-nodes-layer', 'graph-waypoints-layer']) {
        map.on('mouseenter', layerId, () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', layerId, () => {
          map.getCanvas().style.cursor = '';
        });
      }
    });

    map.on('click', (event: MapMouseEvent) => {
      const field = activeFieldRef.current;
      const interactiveLayers = ['landmark-nodes-layer', 'graph-waypoints-layer'].filter((id) =>
        Boolean(map.getLayer(id)),
      );
      if (interactiveLayers.length > 0) {
        const hitFeatures = map.queryRenderedFeatures(event.point, { layers: interactiveLayers });
        if (hitFeatures.length > 0) {
          const props = hitFeatures[0].properties;
          if (props && props.latitude !== undefined && props.longitude !== undefined) {
            putPoint(field, {
              latitude: Number(props.latitude),
              longitude: Number(props.longitude),
              label: String(props.name || (field === 'origin' ? 'Pinned origin' : 'Pinned destination')),
            });
            return;
          }
        }
      }
      putPoint(field, {
        latitude: event.lngLat.lat,
        longitude: event.lngLat.lng,
        label: field === 'origin' ? 'Pinned origin' : 'Pinned destination',
      });
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [putPoint]);

  useEffect(() => {
    const controller = new AbortController();
    const refreshRoute = async () => {
      setLoadingRoute(true);
      setRouteError('');
      try {
        const nextRoute = await getRoute(origin, destination, objective, algorithm, controller.signal);
        if (!controller.signal.aborted) setRoute(nextRoute);
      } catch (error) {
        if (!controller.signal.aborted) {
          setRoute(null);
          setRouteError(error instanceof Error ? error.message : 'Unable to calculate a route');
        }
      } finally {
        if (!controller.signal.aborted) setLoadingRoute(false);
      }
    };
    void refreshRoute();
    return () => controller.abort();
  }, [origin, destination, objective, algorithm]);

  useEffect(() => {
    const controller = new AbortController();
    compareAlgorithms(origin, destination, objective, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          setComparisons(items);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setComparisons([]);
        }
      });
    return () => controller.abort();
  }, [origin, destination, objective]);

  const graphGeoJSON = useMemo(() => buildGraphGeoJSON(graphData), [graphData]);
  const visitedGeoJSON = useMemo(
    () => buildVisitedGeoJSON(graphData, route?.visitedNodeIds),
    [graphData, route?.visitedNodeIds],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const syncGraphLayers = () => {
      (map.getSource('graph-edges') as GeoJSONSource | undefined)?.setData(graphGeoJSON.edges);
      (map.getSource('graph-waypoints') as GeoJSONSource | undefined)?.setData(graphGeoJSON.waypoints);
      (map.getSource('landmark-nodes') as GeoJSONSource | undefined)?.setData(graphGeoJSON.landmarks);
    };
    if (map.getSource('graph-edges')) syncGraphLayers();
    else map.once('load', syncGraphLayers);
  }, [graphGeoJSON]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const syncVisibility = () => {
      const nodeVisibility = showNodes ? 'visible' : 'none';
      for (const layerId of [
        'graph-edges-layer',
        'graph-waypoints-layer',
        'landmark-nodes-layer',
        'landmark-labels-layer',
      ]) {
        if (map.getLayer(layerId)) {
          map.setLayoutProperty(layerId, 'visibility', nodeVisibility);
        }
      }
      if (map.getLayer('visited-nodes-layer')) {
        map.setLayoutProperty('visited-nodes-layer', 'visibility', showVisited ? 'visible' : 'none');
      }
    };
    if (map.getLayer('graph-edges-layer')) syncVisibility();
    else map.once('load', syncVisibility);
  }, [showNodes, showVisited]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const updateMap = () => {
      const routeSource = map.getSource('route') as GeoJSONSource | undefined;
      routeSource?.setData(asRouteFeatureCollection(route));

      const visitedSource = map.getSource('visited-nodes') as GeoJSONSource | undefined;
      visitedSource?.setData(visitedGeoJSON);

      originMarker.current?.remove();
      destinationMarker.current?.remove();
      originMarker.current = new maplibregl.Marker({ color: '#0b0d14', scale: 0.9 })
        .setLngLat([origin.longitude, origin.latitude])
        .setPopup(new maplibregl.Popup({ offset: 24 }).setText(origin.label))
        .addTo(map);
      destinationMarker.current = new maplibregl.Marker({ color: '#3b82f6', scale: 0.9 })
        .setLngLat([destination.longitude, destination.latitude])
        .setPopup(new maplibregl.Popup({ offset: 24 }).setText(destination.label))
        .addTo(map);

      const endpointsKey = `${origin.latitude.toFixed(5)},${origin.longitude.toFixed(5)}->${destination.latitude.toFixed(5)},${destination.longitude.toFixed(5)}`;
      if (
        !loadingRoute &&
        route?.geometry.coordinates.length &&
        !isNavigating &&
        lastFittedEndpointsRef.current !== endpointsKey
      ) {
        lastFittedEndpointsRef.current = endpointsKey;
        const bounds = route.geometry.coordinates.reduce(
          (result, coordinate) => result.extend(coordinate),
          new maplibregl.LngLatBounds(route.geometry.coordinates[0], route.geometry.coordinates[0]),
        );
        const isWideScreen = window.innerWidth > 900;
        map.fitBounds(bounds, {
          padding: isWideScreen
            ? { top: 80, right: 380, bottom: 80, left: 420 }
            : { top: 80, right: 40, bottom: 80, left: 40 },
          maxZoom: 12.6,
          duration: 600,
        });
      }
    };
    if (map.getSource('route')) updateMap();
    else map.once('load', updateMap);
  }, [destination, isNavigating, loadingRoute, origin, route, visitedGeoJSON]);

  useEffect(() => {
    if (!liveLocation || !mapRef.current) return;
    const map = mapRef.current;
    userMarker.current?.remove();
    const element = document.createElement('div');
    element.className = 'live-location-dot';
    userMarker.current = new maplibregl.Marker({ element, rotationAlignment: 'map' })
      .setLngLat([liveLocation.longitude, liveLocation.latitude])
      .addTo(map);
    if (isNavigating) {
      map.easeTo({
        center: [liveLocation.longitude, liveLocation.latitude],
        zoom: Math.max(map.getZoom(), 14),
        duration: 600,
      });
    }
  }, [isNavigating, liveLocation]);

  useEffect(
    () => () => {
      searchControllerRef.current?.abort();
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    },
    [],
  );

  const updateSearch = async (value: string) => {
    setSearchText(value);
    searchControllerRef.current?.abort();
    const controller = new AbortController();
    searchControllerRef.current = controller;
    try {
      const nextSuggestions = await searchPlaces(value, controller.signal);
      if (!controller.signal.aborted) {
        setSuggestions(nextSuggestions);
      }
    } catch {
      if (!controller.signal.aborted) {
        setSuggestions([]);
      }
    }
  };

  const switchPoints = () => {
    closeSearch();
    setOrigin(destination);
    setDestination(origin);
    setActiveField('origin');
  };

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      setNotice('Browser does not support location services');
      return;
    }
    setNotice('Locating current position…');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const point = { latitude: coords.latitude, longitude: coords.longitude, label: 'Current location' };
        setLiveLocation(point);
        putPoint('origin', point);
        mapRef.current?.flyTo({ center: [point.longitude, point.latitude], zoom: 14, essential: true });
        setNotice('Current location set as origin');
      },
      () => setNotice('Location access was not granted'),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const stopNavigation = () => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setIsNavigating(false);
    setNotice('Navigation paused');
  };

  const startNavigation = () => {
    if (!navigator.geolocation) {
      setNotice('Browser does not support location services');
      return;
    }
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setNotice('Navigation active');
    setIsNavigating(true);
    watchIdRef.current = navigator.geolocation.watchPosition(
      ({ coords }) => {
        const point = { latitude: coords.latitude, longitude: coords.longitude, label: 'Current location' };
        setLiveLocation(point);
        if (distanceToRoute(point, routeRef.current) > 120) {
          setOrigin(point);
          setNotice('Off route — recalculating path');
        }
      },
      () => {
        stopNavigation();
        setNotice('Location updates unavailable — navigation paused');
      },
      { enableHighAccuracy: true, maximumAge: 4_000, timeout: 12_000 },
    );
  };

  const activeManeuverIndex = useMemo(() => {
    const maneuvers = route?.maneuvers;
    if (!maneuvers?.length || !isNavigating || !liveLocation) return 0;
    let nearestIndex = 0;
    let nearestDistance = Infinity;
    maneuvers.forEach((maneuver, index) => {
      const distance = haversineMeters(liveLocation, {
        latitude: maneuver.coordinate[1],
        longitude: maneuver.coordinate[0],
        label: '',
      });
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });
    if (nearestIndex === 0 && maneuvers.length > 1 && nearestDistance < 35) {
      return 1;
    }
    return nearestIndex;
  }, [isNavigating, liveLocation, route]);

  const currentManeuver: Maneuver | undefined = route?.maneuvers[activeManeuverIndex];

  const focusManeuver = (maneuver: Maneuver) => {
    mapRef.current?.flyTo({
      center: [maneuver.coordinate[0], maneuver.coordinate[1]],
      zoom: Math.max(mapRef.current.getZoom(), 14.5),
      duration: 600,
      essential: true,
    });
  };

  const totalGraphNodes = graphData?.nodes.length ?? 85;

  return (
    <main className="app-shell">
      <div className="map" ref={mapContainer} aria-label="Interactive map of Delhi NCR" />

      <section className="planner-panel" aria-label="Route planner">
        <header className="panel-header">
          <div className="panel-title-group">
            <h1>Map Navigator</h1>
            <p className="panel-subtitle">Delhi NCR road graph · {totalGraphNodes} nodes</p>
          </div>
          <span className="engine-tag">C++20 · {route?.route.algorithm ?? 'A*'}</span>
        </header>

        <div className="route-inputs" ref={routeInputsRef}>
          <span className="route-spine" aria-hidden="true" />
          {(['origin', 'destination'] as const).map((field) => {
            const point = field === 'origin' ? origin : destination;
            const selected = activeField === field;
            return (
              <label className={`location-field ${selected ? 'selected' : ''}`} key={field}>
                <span className={`location-node ${field}`} aria-hidden="true" />
                <span className="field-content">
                  <span className="field-label">{field === 'origin' ? 'Origin' : 'Destination'}</span>
                  <input
                    value={selected && isEditingSearch ? searchText : point.label}
                    onFocus={() => {
                      setActiveField(field);
                      setIsEditingSearch(true);
                      setSearchText('');
                      void updateSearch('');
                    }}
                    onChange={(event) => {
                      setIsEditingSearch(true);
                      void updateSearch(event.target.value);
                    }}
                    placeholder={field === 'origin' ? 'Search origin' : 'Search destination'}
                    aria-label={field === 'origin' ? 'Origin' : 'Destination'}
                  />
                </span>
                {selected && isEditingSearch && searchText.length > 0 && (
                  <button
                    type="button"
                    className="clear-search"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setSearchText('');
                      void updateSearch('');
                    }}
                    aria-label="Clear search"
                  >
                    <X size={16} strokeWidth={1.5} />
                  </button>
                )}
              </label>
            );
          })}
          <button
            type="button"
            className="swap-button"
            onClick={switchPoints}
            aria-label="Swap origin and destination"
          >
            <ArrowDownUp size={16} strokeWidth={1.5} />
          </button>

          {isEditingSearch && suggestions.length > 0 && (
            <div className="suggestions" role="listbox" aria-label="Location suggestions">
              {suggestions.map((place) => (
                <button
                  type="button"
                  key={place.id}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => putPoint(activeField, place)}
                >
                  <MapPin size={16} strokeWidth={1.5} />
                  <span>{place.label}</span>
                  <ChevronRight size={16} strokeWidth={1.5} />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="utility-row">
          <button type="button" className="utility-action" onClick={useCurrentLocation}>
            <LocateFixed size={16} strokeWidth={1.5} />
            <span>Use current location</span>
          </button>
          <div className="layer-toggles" role="group" aria-label="Map overlays">
            <button
              type="button"
              className={`layer-pill ${showNodes ? 'active' : ''}`}
              onClick={() => setShowNodes((prev) => !prev)}
            >
              <span className="layer-dot graph" aria-hidden="true" />
              <span>Graph nodes</span>
            </button>
            <button
              type="button"
              className={`layer-pill ${showVisited ? 'active' : ''}`}
              onClick={() => setShowVisited((prev) => !prev)}
            >
              <span className="layer-dot visited" aria-hidden="true" />
              <span>Explored</span>
            </button>
          </div>
        </div>

        <div className="controls-stack">
          <div className="objective-switch" role="group" aria-label="Route objective">
            <button
              type="button"
              className={objective === 'fastest' ? 'active' : ''}
              onClick={() => setObjective('fastest')}
            >
              Fastest
            </button>
            <button
              type="button"
              className={objective === 'shortest' ? 'active' : ''}
              onClick={() => setObjective('shortest')}
            >
              Shortest
            </button>
          </div>

          <div className="algorithm-switch" role="group" aria-label="Routing algorithm">
            {ALGORITHM_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={algorithm === option.id ? 'active' : ''}
                onClick={() => setAlgorithm(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {routeError ? (
          <div className="error-card" role="alert">
            <TriangleAlert size={16} strokeWidth={1.5} />
            <span>{routeError}</span>
          </div>
        ) : (
          <div className="route-summary">
            <div className="stat-strip">
              <div className="stat-cell">
                <span className="stat-label">Duration</span>
                <strong className="stat-value">
                  {loadingRoute && !route ? '…' : route ? formatDuration(route.route.durationSeconds) : '—'}
                </strong>
              </div>
              <div className="stat-cell">
                <span className="stat-label">Distance</span>
                <strong className="stat-value">
                  {loadingRoute && !route ? '…' : route ? formatDistance(route.route.distanceMeters) : '—'}
                </strong>
              </div>
              <div className="stat-cell">
                <span className="stat-label">Explored</span>
                <strong className="stat-value">
                  {loadingRoute && !route
                    ? '…'
                    : route
                      ? `${route.route.visitedNodes} / ${totalGraphNodes}`
                      : '—'}
                </strong>
              </div>
            </div>

            {comparisons.length > 0 && (
              <div className="comparison-section">
                <div className="section-header">
                  <span className="section-title">Algorithm benchmark</span>
                  <span className="section-meta">Click row to inspect</span>
                </div>
                <div className="comparison-table" role="region" aria-label="Algorithm comparison">
                  <div className="comparison-head">
                    <span>Algorithm</span>
                    <span>Visited</span>
                    <span>Distance</span>
                    <span>Time</span>
                  </div>
                  {comparisons.map((item) => {
                    const selected = item.algorithmId === algorithm;
                    return (
                      <button
                        key={item.algorithmId}
                        type="button"
                        className={`comparison-row ${selected ? 'active' : ''}`}
                        onClick={() => setAlgorithm(item.algorithmId)}
                      >
                        <span className="comparison-algo">
                          <span className={`algo-dot ${selected ? 'active' : ''}`} aria-hidden="true" />
                          <span className="algo-name">{item.algorithm}</span>
                          {!item.optimal && <span className="suboptimal-tag">Suboptimal</span>}
                        </span>
                        <span className="comparison-num">{item.visitedNodes}</span>
                        <span className="comparison-num">{formatDistance(item.distanceMeters)}</span>
                        <span className="comparison-num">{formatMicros(item.executionMicros)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="panel-footer">
          <button
            type="button"
            className={`navigate-button ${isNavigating ? 'navigating' : ''}`}
            disabled={!route || loadingRoute}
            onClick={isNavigating ? stopNavigation : startNavigation}
          >
            <Navigation size={16} strokeWidth={1.5} />
            <span>{isNavigating ? 'Pause navigation' : 'Start navigation'}</span>
          </button>
          {notice && <p className="notice">{notice}</p>}
        </div>
      </section>

      {route && route.maneuvers.length > 0 && !routeError && (
        <aside className="itinerary-panel" aria-label="Turn-by-turn itinerary">
          <div className="section-header">
            <span className="section-title">Turn-by-turn itinerary</span>
            <span className="section-meta">{route.maneuvers.length} steps</span>
          </div>
          <ol className="maneuver-list">
            {route.maneuvers.map((maneuver, index) => {
              const isLast = index === route.maneuvers.length - 1;
              const isCurrent = isNavigating && index === activeManeuverIndex;
              return (
                <li key={`${maneuver.instruction}-${index}`}>
                  <button
                    type="button"
                    className={`maneuver-row ${isCurrent ? 'active' : ''}`}
                    onClick={() => focusManeuver(maneuver)}
                  >
                    <span
                      className={`maneuver-node ${index === 0 ? 'origin' : isLast ? 'destination' : 'waypoint'}`}
                      aria-hidden="true"
                    />
                    <span className="maneuver-instruction">{maneuver.instruction}</span>
                    <span className="maneuver-distance">
                      {isLast ? 'Arrive' : formatDistance(maneuver.metersToNext)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>
      )}

      {isNavigating && currentManeuver && (
        <section className="navigation-banner" aria-live="polite">
          <div className="maneuver-icon">
            <Navigation size={16} strokeWidth={1.5} />
          </div>
          <div className="banner-copy">
            <p className="banner-label">Next turn</p>
            <strong className="banner-instruction">{currentManeuver.instruction}</strong>
          </div>
          <span className="banner-distance">{formatDistance(currentManeuver.metersToNext)}</span>
        </section>
      )}
    </main>
  );
}
