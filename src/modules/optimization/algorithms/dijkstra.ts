import { MinHeap } from './binary-heap';

export type GraphEdge = { to: string; weightMinutes: number };
export type WeightedGraph = Map<string, GraphEdge[]>;

export type DijkstraResult = {
  minutes: number;
  path: string[];
  nodesExpanded: number;
};

/**
 * Dijkstra shortest-time path — classic O((V+E) log V) with binary heap.
 * Edge weights are travel minutes (not distance), so we minimize response time.
 */
export function dijkstraShortestTime(
  graph: WeightedGraph,
  source: string,
  target: string,
): DijkstraResult | null {
  if (source === target) {
    return { minutes: 0, path: [source], nodesExpanded: 0 };
  }

  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const heap = new MinHeap<{ id: string; d: number }>((a, b) => a.d < b.d);

  dist.set(source, 0);
  prev.set(source, null);
  heap.push({ id: source, d: 0 });

  let expanded = 0;
  while (heap.size) {
    const cur = heap.pop()!;
    if (cur.d !== dist.get(cur.id)) continue;
    expanded++;
    if (cur.id === target) break;

    for (const e of graph.get(cur.id) || []) {
      const nd = cur.d + e.weightMinutes;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, cur.id);
        heap.push({ id: e.to, d: nd });
      }
    }
  }

  if (!dist.has(target)) return null;

  const path: string[] = [];
  let walk: string | null | undefined = target;
  while (walk) {
    path.push(walk);
    walk = prev.get(walk) ?? null;
  }
  path.reverse();

  return {
    minutes: dist.get(target)!,
    path,
    nodesExpanded: expanded,
  };
}

/**
 * Build a lat/lng mesh graph for a region. Blocked cells get infinite / removed edges.
 * Used when Google Maps is unavailable or roads are disrupted.
 */
export function buildRegionMeshGraph(input: {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  step?: number;
  speedKmh?: number;
  blocks?: { lat: number; lng: number; radiusKm: number }[];
}): { graph: WeightedGraph; nearestNode: (lat: number, lng: number) => string } {
  const step = input.step ?? 0.04;
  const speed = input.speedKmh ?? 35;
  const nodes: { id: string; lat: number; lng: number }[] = [];

  for (let lat = input.minLat; lat <= input.maxLat + 1e-9; lat += step) {
    for (let lng = input.minLng; lng <= input.maxLng + 1e-9; lng += step) {
      if (isBlocked(lat, lng, input.blocks)) continue;
      nodes.push({
        id: `n:${lat.toFixed(3)},${lng.toFixed(3)}`,
        lat,
        lng,
      });
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const graph: WeightedGraph = new Map();
  for (const n of nodes) graph.set(n.id, []);

  const dirs = [
    [step, 0],
    [-step, 0],
    [0, step],
    [0, -step],
    [step, step],
    [step, -step],
    [-step, step],
    [-step, -step],
  ];

  for (const n of nodes) {
    for (const [dLat, dLng] of dirs) {
      const id = `n:${(n.lat + dLat).toFixed(3)},${(n.lng + dLng).toFixed(3)}`;
      if (!byId.has(id)) continue;
      const distKm = Math.hypot(dLat * 111, dLng * 111 * Math.cos((n.lat * Math.PI) / 180));
      const minutes = (distKm / speed) * 60;
      graph.get(n.id)!.push({ to: id, weightMinutes: minutes });
    }
  }

  const nearestNode = (lat: number, lng: number) => {
    let best = nodes[0]?.id;
    let bestD = Infinity;
    for (const n of nodes) {
      const d = (n.lat - lat) ** 2 + (n.lng - lng) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best || 'n:0,0';
  };

  return { graph, nearestNode };
}

function isBlocked(
  lat: number,
  lng: number,
  blocks?: { lat: number; lng: number; radiusKm: number }[],
) {
  if (!blocks?.length) return false;
  for (const b of blocks) {
    const dKm = Math.hypot(
      (lat - b.lat) * 111,
      (lng - b.lng) * 111 * Math.cos((lat * Math.PI) / 180),
    );
    if (dKm < b.radiusKm) return true;
  }
  return false;
}
