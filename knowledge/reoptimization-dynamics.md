# Continuous Reoptimization Under Dynamic Conditions

1. Environment may change at any time: new incidents, ROAD_BLOCKED, HOSPITAL_FULL, VEHICLE_FAILED, WEATHER_HAZARD, COMMS_DELAY.
2. On material change, invalidate ETA/route caches and enqueue region-scoped reoptimization.
3. Critical disruptions (severity ≥ 4 infeasible plans, vehicle failures) trigger immediate reopt; lesser changes may debounce briefly to avoid thrashing.
4. Reassign only when the current plan is infeasible OR a material improvement in total response time is available.
5. COMMS_DELAY: widen acknowledgment timeouts; do not assume message loss equals resource failure without heartbeat timeout policy.
6. Near-real-time goal: hot-path algorithmic assign in milliseconds; explainability agents run asynchronously after commit.
7. Throughput under load: queue-backed ingest, priority lanes for critical incidents, load shedding when queue depth exceeds safe limits.
