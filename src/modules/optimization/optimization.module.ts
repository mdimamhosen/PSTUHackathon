import { Module } from '@nestjs/common';
import { ResourceMatcher } from './resource.matcher';
import { RoutingService } from './routing.service';
import { OptimizationController } from './optimization.controller';

@Module({
  controllers: [OptimizationController],
  providers: [ResourceMatcher, RoutingService],
  exports: [ResourceMatcher, RoutingService],
})
export class OptimizationModule {}
