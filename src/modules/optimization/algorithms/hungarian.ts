/**
 * Kuhn–Munkres (Hungarian) algorithm — O(n³) optimal bipartite assignment.
 * Minimizes total cost (we use travel-time minutes as cost).
 * Ideal for region batch reoptimization under capacity.
 *
 * Cost matrix: rows = incidents (or demand slots), cols = resources.
 * Returns matching: row -> col index, or -1 if unmatched.
 */
export function hungarianMinCost(cost: number[][]): {
  assignment: number[];
  totalCost: number;
} {
  const n = cost.length;
  const m = cost[0]?.length ?? 0;
  if (!n || !m) return { assignment: [], totalCost: 0 };

  // Pad to square
  const dim = Math.max(n, m);
  const BIG = 1e9;
  const a: number[][] = Array.from({ length: dim }, (_, i) =>
    Array.from({ length: dim }, (_, j) =>
      i < n && j < m ? cost[i][j] : BIG,
    ),
  );

  const u = Array(dim + 1).fill(0);
  const v = Array(dim + 1).fill(0);
  const p = Array(dim + 1).fill(0);
  const way = Array(dim + 1).fill(0);

  for (let i = 1; i <= dim; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = Array(dim + 1).fill(Infinity);
    const used = Array(dim + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= dim; j++) {
        if (used[j]) continue;
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= dim; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const assignment = Array(n).fill(-1);
  let totalCost = 0;
  for (let j = 1; j <= dim; j++) {
    if (p[j] > 0 && p[j] <= n && j <= m) {
      const row = p[j] - 1;
      const col = j - 1;
      if (cost[row][col] < BIG / 2) {
        assignment[row] = col;
        totalCost += cost[row][col];
      }
    }
  }
  return { assignment, totalCost };
}
