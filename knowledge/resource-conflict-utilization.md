# Resource Conflict Prevention & Utilization

1. Never double-book a resource unit: reservations must be transactional with version checks.
2. Maximize utilization by preferring fit-for-purpose resources with remainingCapacity and acceptable ETA — avoid idle specialty assets when a nearer equivalent exists.
3. Soft holds for lower-severity incidents may be released when a severity ≥ 4 incident has zero feasible free resources (preemption must be audited with actor/reason).
4. When VEHICLE_FAILED or MAINTENANCE occurs, immediately RELEASE active assignments and enqueue region reoptimization.
5. HOSPITAL_FULL sets remainingCapacity to 0 and removes the hospital from candidate sets until capacity is restored.
6. Batch reoptimization should minimize total response time (sum of ETAs) across pending incidents in a region, not optimize one incident in isolation when many compete.
7. Idempotent ingest prevents duplicate incidents from consuming the same scarce resources twice.
