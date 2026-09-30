/** NERV scene worker: renders one scene per request and, for a clocked change, composites both plates through AvsTransition.
 * Stateless across seeks: every frame is rebuilt from the absolute clock in the message (docs/design/CONTRACT.md 2.3.4).
 *  - Size: the requested size is fitted uniformly inside HARD_MAX_EDGE and HARD_MAX_PIXELS (render-resolution.ts), never per axis, and the applied size is reported.
 *  - Timing: the saved grid and the scene bounds reach both plates; the outgoing plate gets its own bounds so its interval signals are its own.
 *  - Transition: the env is built from timingSignals() and the wire fields; the construction context and cache key follow mode:seed:beats:boundary:reduced.
 *  - Memory: the two transition surfaces and the cached transition are released as soon as a frame no longer needs them.
 *  - Errors: a non-finite clock number, a malformed grid or a negative fadeSeconds throw 'Invalid transition clock'; a transition style, length,
 *    boundary, accent or reduced flag outside its range throws 'Invalid scene transition'. `grid`, `sceneStart`, `sceneEnd`, `previousSceneStart` and
 *    `previousSceneEnd` may be null (absent). */
import type { AvsWorkerRequest } from './avs-worker-protocol.ts';
import { createNervLegacyRenderer } from './nerv-legacy-render.ts';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AvsWorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
const handle = createNervLegacyRenderer((message, transfer) => scope.postMessage(message, transfer));
scope.onmessage = ({data: message}) => handle(message);
