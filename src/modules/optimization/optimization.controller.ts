import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('optimization')
@Controller('optimization')
export class OptimizationController {
  @Public()
  @Get('strategy')
  strategy() {
    return {
      objective: 'Minimize total emergency response time (Σ ETA minutes)',
      streamingDispatch: {
        steps: [
          'Spatial grid index prune candidates (O(k) vs O(N))',
          'Min travel-time estimate: Google Distance Matrix OR Dijkstra shortest-time on region mesh (avoids ROAD_BLOCKED)',
          'Cost = ETA + type/constraint penalties; severity soft-weights critical cases',
          'Greedy min-cost with type diversity under transactional reserve',
        ],
        complexity: 'O(k log k + k·T_eta) per incident after spatial prune',
      },
      batchReoptimization: {
        algorithm: 'Kuhn–Munkres (Hungarian) min-cost bipartite matching',
        steps: [
          'Build demand slots from urgency-ordered pending incidents',
          'Cost matrix[i][j] = min travel time resource j → incident i',
          'Hungarian minimizes Σ cost (globally optimal for bipartite assignment)',
          'Commit with optimistic locking to prevent double-booking',
        ],
        complexity: 'O(n³) for n≤~50 region batch — ideal for regional reopt windows',
      },
      routing: {
        primary: 'Google Maps Distance Matrix (real road times)',
        fallback: 'Dijkstra on region mesh with blocked cells removed',
        lastResort: 'Haversine + assumed speed',
      },
      whyNotMILP: 'Near-real-time SLA: Hungarian + Dijkstra are explainable, optimal for assignment/path subproblems, and scale under streaming load',
    };
  }
}
