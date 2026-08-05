import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ResourceMatcher } from '../optimization/resource.matcher';
import { MapsService } from '../maps/maps.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { QUEUE_NOTIFY, QUEUE_REOPT } from './queue.constants';

@Processor(QUEUE_REOPT, { concurrency: 4 })
export class ReoptProcessor extends WorkerHost {
  private readonly logger = new Logger(ReoptProcessor.name);

  constructor(
    private readonly matcher: ResourceMatcher,
    private readonly maps: MapsService,
    private readonly realtime: RealtimeGateway,
    @InjectQueue(QUEUE_NOTIFY) private readonly notifyQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<{ regionId: string; reason?: string }>) {
    this.logger.log(`Reopt region ${job.data.regionId}: ${job.data.reason}`);
    await this.maps.invalidateRegionApprox();
    const result = await this.matcher.reoptimizeRegion(job.data.regionId);
    this.realtime.emitEvent(job.data.regionId, {
      type: 'reopt',
      ...result,
      reason: job.data.reason,
    });
    if (result.released > 0) {
      await this.notifyQueue.add('alert', {
        title: 'Reoptimization triggered',
        body: `Region ${job.data.regionId}: released ${result.released}, processed ${result.processed}. Reason: ${job.data.reason || 'environment change'}`,
        severity: 4,
      });
    }
    return result;
  }
}
