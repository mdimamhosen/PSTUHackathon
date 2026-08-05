import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { MapsModule } from '../maps/maps.module';

@Module({
  imports: [MapsModule],
  controllers: [HealthController],
})
export class HealthModule {}
