import { MobileWalletConfigurationError } from "./errors";

// Clipboard hygiene.
//
// Addresses and payment references copied from a wallet sit in a clipboard
// every other app can read. This helper clears the clipboard after a TTL —
// but only if the clipboard still holds the value the wallet placed there, so
// it never destroys something the user copied afterwards.

const DEFAULT_TTL_MS = 60_000;

export interface ClipboardBackend {
  getString(): Promise<string>;
  setString(value: string): Promise<void>;
}

export type ScheduleFn = (callback: () => void, delayMs: number) => () => void;

const defaultSchedule: ScheduleFn = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

export interface ClipboardHygiene {
  /**
   * Copies a sensitive value and schedules its removal. Returns the TTL used
   * so the UI can show a countdown.
   */
  copySensitive(value: string): Promise<{ readonly clearsInMs: number }>;
}

export function createClipboardHygiene(input: {
  clipboard: ClipboardBackend;
  ttlMs?: number;
  schedule?: ScheduleFn;
}): ClipboardHygiene {
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new MobileWalletConfigurationError("Clipboard TTL must be a positive integer of milliseconds.");
  }
  const schedule = input.schedule ?? defaultSchedule;
  let cancelPending: (() => void) | undefined;

  return {
    async copySensitive(value) {
      if (value.length === 0) {
        throw new MobileWalletConfigurationError("Refusing to copy an empty value.");
      }
      cancelPending?.();
      await input.clipboard.setString(value);
      cancelPending = schedule(() => {
        void input.clipboard
          .getString()
          .then(current => {
            // Only clear if the clipboard still holds our value; never
            // clobber something the user copied in the meantime.
            if (current === value) {
              return input.clipboard.setString("");
            }
            return undefined;
          })
          .catch(() => {
            // Clearing is best-effort; a read failure must not crash the app.
          });
      }, ttlMs);
      return { clearsInMs: ttlMs };
    }
  };
}
