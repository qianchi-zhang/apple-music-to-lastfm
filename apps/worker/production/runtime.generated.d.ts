export class ScrobbleCoordinator {
  constructor(state: any, env: any);
  enqueue(manual?: boolean, source?: string): Promise<any>;
}
export function loadLedger(kv: any): Promise<any>;
export function saveLedger(kv: any, ledger: any): Promise<void>;
export function fetchRecentlyPlayed(dev: string, user: string): Promise<any[]>;
export default { fetch: Function };
