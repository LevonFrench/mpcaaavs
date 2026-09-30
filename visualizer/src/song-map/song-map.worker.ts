// Song-map analysis worker entry. All logic lives in engine.ts.
import { SongMapEngine } from './engine.ts';
import type { SongMapRequest, SongMapResponse } from './protocol.ts';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SongMapRequest>) => void) | null;
  postMessage(message: SongMapResponse, transfer?: Transferable[]): void;
};
const engine = new SongMapEngine((message, transfer) => scope.postMessage(message, transfer ?? []));
scope.onmessage = event => engine.handle(event.data);
