import qrcode from "qrcode-generator";

export interface QrGeometry {
  readonly size: number;
  readonly path: string;
}

/**
 * Build a QR code as a local SVG path.
 *
 * Encoding happens in the page: no image service, no hosted generator, and
 * nothing about the encoded value leaves the device. Returns `null` rather than
 * throwing when the value cannot be encoded, so a caller can fall back to
 * showing the text itself.
 */
export function createQrGeometry(value: string): QrGeometry | null {
  try {
    const code = qrcode(0, "L");
    code.addData(value, "Byte");
    code.make();
    const margin = 4;
    const modules = code.getModuleCount();
    const runs: string[] = [];
    for (let row = 0; row < modules; row += 1) {
      let start = -1;
      for (let column = 0; column <= modules; column += 1) {
        const dark = column < modules && code.isDark(row, column);
        if (dark && start < 0) start = column;
        if (!dark && start >= 0) {
          runs.push(`M${start + margin} ${row + margin}h${column - start}v1H${start + margin}z`);
          start = -1;
        }
      }
    }
    return { size: modules + margin * 2, path: runs.join("") };
  } catch {
    return null;
  }
}
