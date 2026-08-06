import { Module } from '@nestjs/common';
import { KafkaIngressConsumer } from './kafka.ingress.consumer';
import { IncidentsModule } from '../incidents/incidents.module';
import { EventsModule } from '../events/events.module';
import { ResourcesModule } from '../resources/resources.module';

/** Worker-side real-time consumers (region gateway ingress). */
@Module({
  imports: [IncidentsModule, EventsModule, ResourcesModule],
  providers: [KafkaIngressConsumer],
})
export class KafkaIngressModule {}
