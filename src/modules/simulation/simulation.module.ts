import { Module } from '@nestjs/common';
import { SimulationController } from './simulation.controller';
import { IncidentsModule } from '../incidents/incidents.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [IncidentsModule, EventsModule],
  controllers: [SimulationController],
})
export class SimulationModule {}
