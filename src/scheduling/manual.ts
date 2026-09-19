export const manualRunWindowMs = 10 * 60_000;
export type ManualRunResult = 'queued' | 'unconfigured' | 'busy';
export type ManualRun = { key: string; expiresAt: Date };
