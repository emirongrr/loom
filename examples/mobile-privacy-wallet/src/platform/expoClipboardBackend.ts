import * as Clipboard from "expo-clipboard";

import type { ClipboardBackend } from "./clipboardHygiene";

export function createExpoClipboardBackend(): ClipboardBackend {
  return {
    getString() {
      return Clipboard.getStringAsync();
    },
    async setString(value) {
      await Clipboard.setStringAsync(value);
    }
  };
}
