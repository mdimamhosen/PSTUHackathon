import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  NotificationsService,
  AlertPayload,
} from '../notifications/notifications.service';
import { QUEUE_NOTIFY } from './queue.constants';

@Processor(QUEUE_NOTIFY, { concurrency: 4 })
export class NotifyProcessor extends WorkerHost {
  constructor(private readonly notifications: NotificationsService) {
    super();
  }

  async process(job: Job<AlertPayload>) {
    return this.notifications.sendAlert(job.data);
  }
}
