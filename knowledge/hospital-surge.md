# Hospital Surge & Triage

1. When remainingCapacity reaches zero, emit HOSPITAL_FULL and remove from candidate set.
2. Critical (severity 5) patients may preempt lower-severity soft holds if no alternate beds exist.
3. Document every preemption with actor and reason for audit.
4. Keep utilization high without double-booking beds — transactional reserves required.
