/**
 * Uniform spatial grid index — O(1) cell insert, O(k) neighbor query.
 * Scales candidate search for thousands of resources without scanning all.
 */
export class SpatialGrid<T extends { lat: number; lng: number; id: string }> {
  private cells = new Map<string, T[]>();

  constructor(private readonly cellDeg = 0.05) {}

  clear() {
    this.cells.clear();
  }

  insert(item: T) {
    const key = this.key(item.lat, item.lng);
    const arr = this.cells.get(key) || [];
    arr.push(item);
    this.cells.set(key, arr);
  }

  /** Query items in Chebyshev ring of `rings` cells around point. */
  queryNear(lat: number, lng: number, rings = 2): T[] {
    const ci = Math.floor(lat / this.cellDeg);
    const cj = Math.floor(lng / this.cellDeg);
    const out: T[] = [];
    for (let di = -rings; di <= rings; di++) {
      for (let dj = -rings; dj <= rings; dj++) {
        const key = `${ci + di}:${cj + dj}`;
        const bucket = this.cells.get(key);
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }

  private key(lat: number, lng: number) {
    return `${Math.floor(lat / this.cellDeg)}:${Math.floor(lng / this.cellDeg)}`;
  }
}
