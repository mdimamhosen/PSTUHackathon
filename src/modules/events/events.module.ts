import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { RegionsModule } from '../regions/regions.module';
import { OptimizationModule } from '../optimization/optimization.module';

@Module({
  imports: [RegionsModule, OptimizationModule],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
