import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import type { DealState, DealEvent, DealInput } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data/deals');

export class PersistenceManager {
  private static ensureDealDir(dealId: string) {
    const dir = path.join(DATA_DIR, dealId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  static saveEvent(dealId: string, event: DealEvent) {
    const dir = this.ensureDealDir(dealId);
    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(event) + '\n');
  }

  static saveState(dealId: string, state: DealState) {
    const dir = this.ensureDealDir(dealId);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
  }

  static getState(dealId: string): DealState | null {
    const filePath = path.join(DATA_DIR, dealId, 'state.json');
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  static saveNodeMemory(dealId: string, nodeId: string, memory: any) {
    const dir = this.ensureDealDir(dealId);
    fs.writeFileSync(path.join(dir, `mem_node_${nodeId}.json`), JSON.stringify(memory, null, 2));
  }

  static saveEdgeMemory(dealId: string, from: string, to: string, memory: any) {
    const dir = this.ensureDealDir(dealId);
    fs.writeFileSync(path.join(dir, `mem_edge_${from}_${to}.json`), JSON.stringify(memory, null, 2));
  }
}
