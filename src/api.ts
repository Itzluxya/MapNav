import type {
  AlgorithmComparison,
  AlgorithmId,
  Coordinate,
  GraphData,
  Objective,
  Place,
  RouteResponse,
} from './types';

const engineUnavailableMessage =
  'The C++ routing engine is not running. In this project folder, run “npm run dev:full”, then refresh this page.';

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return false;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = await response.text();
  let payload: { error?: string } | null = null;
  try {
    payload = body ? (JSON.parse(body) as { error?: string }) : null;
  } catch {
    throw new Error(response.status >= 500 ? engineUnavailableMessage : 'The routing service returned an invalid response.');
  }
  if (!response.ok) throw new Error(payload?.error ?? engineUnavailableMessage);
  if (payload === null) throw new Error(engineUnavailableMessage);
  return payload as T;
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal });
    const payload = await parseResponse<{
      results: Array<{ id: number; name: string; latitude: number; longitude: number }>;
    }>(response);
    return payload.results.map((place) => ({
      id: place.id,
      label: place.name,
      latitude: place.latitude,
      longitude: place.longitude,
    }));
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    return [];
  }
}

export async function getGraph(signal?: AbortSignal): Promise<GraphData> {
  const response = await fetch('/api/graph', { signal });
  return parseResponse<GraphData>(response);
}

export async function getRoute(
  origin: Coordinate,
  destination: Coordinate,
  objective: Objective,
  algorithm: AlgorithmId = 'astar',
  signal?: AbortSignal,
): Promise<RouteResponse> {
  const query = new URLSearchParams({
    fromLat: origin.latitude.toString(),
    fromLng: origin.longitude.toString(),
    toLat: destination.latitude.toString(),
    toLng: destination.longitude.toString(),
    objective,
    algorithm,
  });
  try {
    const response = await fetch(`/api/route?${query}`, { signal });
    return await parseResponse<RouteResponse>(response);
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    if (error instanceof Error && error.message !== 'Failed to fetch') throw error;
    throw new Error(engineUnavailableMessage);
  }
}

export async function compareAlgorithms(
  origin: Coordinate,
  destination: Coordinate,
  objective: Objective,
  signal?: AbortSignal,
): Promise<AlgorithmComparison[]> {
  const query = new URLSearchParams({
    fromLat: origin.latitude.toString(),
    fromLng: origin.longitude.toString(),
    toLat: destination.latitude.toString(),
    toLng: destination.longitude.toString(),
    objective,
  });
  try {
    const response = await fetch(`/api/compare?${query}`, { signal });
    const payload = await parseResponse<{ comparisons: AlgorithmComparison[] }>(response);
    return payload.comparisons;
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    return [];
  }
}
