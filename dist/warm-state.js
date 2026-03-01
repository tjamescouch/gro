/**
 * WarmState — serializable snapshot of all gro runtime state.
 *
 * Transferred via IPC between supervisor and worker process.
 * Never touches disk. Preserves everything that cold storage loses:
 * spend meter, violations, familiarity/deja-vu trackers, thinking budget.
 */
export const WARM_STATE_VERSION = 1;
