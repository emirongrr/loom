/**
 * A one-shot camera read for a recipient address.
 *
 * Deliberately narrow, because a camera is the most invasive capability this
 * wallet asks for:
 *
 * - it is started only by an explicit user action, never on mount;
 * - the stream is stopped on the first successful read, on cancellation, and on
 *   any failure, so the camera light never outlives the task;
 * - decoding uses the browser's own `BarcodeDetector`. No frame is uploaded, no
 *   decoding service is contacted, and no image is retained;
 * - where `BarcodeDetector` is absent the caller is told, and typing or pasting
 *   remains the way in. Adding a decoding library to reach the rest would put a
 *   new dependency inside a wallet's signing path for a convenience.
 */

export interface RecipientScanner {
  /** Whether this browser can decode without help. */
  readonly available: boolean;
  /** Resolves with the decoded text, or null when the caller cancels. */
  scan(input: { readonly video: HTMLVideoElement; readonly signal: AbortSignal }): Promise<string | null>;
}

interface DetectorLike {
  detect(source: CanvasImageSource): Promise<readonly { readonly rawValue?: unknown }[]>;
}
type DetectorConstructor = new (options: { formats: readonly string[] }) => DetectorLike;

export function createRecipientScanner(
  media: MediaDevices | undefined = typeof navigator === "undefined" ? undefined : navigator.mediaDevices,
  Detector: DetectorConstructor | undefined =
    (globalThis as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector
): RecipientScanner {
  const available = Boolean(media?.getUserMedia && Detector);

  return Object.freeze({
    available,
    async scan({ video, signal }: { readonly video: HTMLVideoElement; readonly signal: AbortSignal }): Promise<string | null> {
      if (!available || !media || !Detector) throw new Error("This browser cannot scan a code.");
      const detector = new Detector({ formats: ["qr_code"] });
      const stream = await media.getUserMedia({ video: { facingMode: "environment" } });
      // One stop path for every exit, so no branch can leave the camera on.
      const stop = () => { for (const track of stream.getTracks()) track.stop(); };
      try {
        video.srcObject = stream;
        await video.play();
        while (!signal.aborted) {
          const found = await readOnce(detector, video);
          if (found !== null) return found;
          await new Promise(resolve => setTimeout(resolve, 120));
        }
        return null;
      } finally {
        stop();
        video.srcObject = null;
      }
    }
  });
}

async function readOnce(detector: DetectorLike, video: HTMLVideoElement): Promise<string | null> {
  try {
    const results = await detector.detect(video);
    for (const result of results) {
      if (typeof result.rawValue === "string" && result.rawValue.length > 0) return result.rawValue;
    }
  } catch {
    // A frame that cannot be decoded is ordinary; keep looking until cancelled.
  }
  return null;
}
