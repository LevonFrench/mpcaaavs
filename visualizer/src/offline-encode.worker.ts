import { writePngFrame } from './offline-png.ts';
import type {
  OfflineEncodeWorkerRequest,
  OfflineEncodeWorkerResponse,
} from './offline-render-protocol.ts';

/*
 * Dedicated PNG encoder for the offline renderer. CompressionStream's DEFLATE
 * runs on the calling thread, so moving it here lets the render worker keep
 * rendering while 1-3 of these deflate, hash and write in parallel. Bytes are
 * identical to in-thread encoding because both paths call writePngFrame.
 */

interface EncodeWorkerScope {
  onmessage: ((event: MessageEvent<OfflineEncodeWorkerRequest>) => void) | null;
  postMessage(message: OfflineEncodeWorkerResponse, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as EncodeWorkerScope;

let width = 0;
let height = 0;
let framesDirectory: FileSystemDirectoryHandle | null = null;
let refuseExisting = false;
let cancelled = false;
const isCancelled = () => cancelled;

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'init') {
    width = message.width;
    height = message.height;
    framesDirectory = message.framesDirectory;
    refuseExisting = message.refuseExisting;
    cancelled = false;
    scope.postMessage({ type: 'ready' });
    return;
  }
  if (message.type === 'cancel') {
    cancelled = true;
    return;
  }
  void encode(message.frame, message.scanlines);
};

async function encode(frame: number, buffer: ArrayBuffer): Promise<void> {
  try {
    if (!framesDirectory) throw new Error('PNG encoder worker received a frame before init');
    const result = cancelled ? null : await writePngFrame(
      framesDirectory, new Uint8Array(buffer), width, height, frame,
      { refuseExisting, cancelled: isCancelled },
    );
    scope.postMessage({ type: 'encoded', frame, scanlines: buffer, result }, [buffer]);
  } catch (error) {
    scope.postMessage({
      type: 'error', frame, scanlines: buffer,
      message: error instanceof Error ? error.message : String(error),
    }, [buffer]);
  }
}
