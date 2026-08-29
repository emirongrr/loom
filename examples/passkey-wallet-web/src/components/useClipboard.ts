import { useState } from "react";

/**
 * Copying, with the same answer everywhere.
 *
 * Seventeen call sites wrote this out by hand, nine of them with their own
 * failure sentence and six with the identical one. That is not only repetition:
 * it is seventeen chances for one of them to report success before the write
 * resolved, or to say nothing at all when the browser refuses.
 *
 * The fallback matters. Clipboard access is denied on insecure origins and in
 * some embedded views, and the person still needs the value -- so a refusal
 * says what to do instead rather than only that it failed.
 */
export interface ClipboardState {
  /** The last outcome, ready to render. Empty until something is copied. */
  readonly message: string;
  readonly failed: boolean;
  readonly copy: (value: string, options?: CopyOptions) => Promise<boolean>;
  readonly reset: () => void;
}

export interface CopyOptions {
  /** What was copied, for the confirmation. Defaults to a plain "Copied." */
  readonly what?: string;
  /** What to do when the browser refuses. Shown after the refusal. */
  readonly fallback?: string;
}

export function useClipboard(): ClipboardState {
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  const copy = async (value: string, options: CopyOptions = {}): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(value);
      setFailed(false);
      setMessage(options.what ? `${options.what} copied.` : "Copied.");
      return true;
    } catch {
      setFailed(true);
      setMessage(`Clipboard access is unavailable.${options.fallback ? ` ${options.fallback}` : ""}`);
      return false;
    }
  };

  return { message, failed, copy, reset: () => { setMessage(""); setFailed(false); } };
}
