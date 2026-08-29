import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useClipboard } from "../../src/components/useClipboard.ts";

const withClipboard = (writeText: () => Promise<void>) => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
};

afterEach(() => { vi.restoreAllMocks(); });

test("a successful copy names what was copied", async () => {
  withClipboard(async () => undefined);
  const { result } = renderHook(() => useClipboard());
  await act(async () => { await result.current.copy("0xabc", { what: "Address" }); });
  expect(result.current.message).toBe("Address copied.");
  expect(result.current.failed).toBe(false);
});

// Clipboard access is denied on insecure origins and in some embedded views.
// The person still needs the value, so a refusal says what to do instead.
test("a refusal reports the reason and the way around it", async () => {
  withClipboard(async () => { throw new Error("denied"); });
  const { result } = renderHook(() => useClipboard());
  await act(async () => { await result.current.copy("0xabc", { what: "Address", fallback: "Select it and copy manually." }); });
  expect(result.current.failed).toBe(true);
  expect(result.current.message).toMatch(/unavailable\. Select it and copy manually\./);
});

test("copy reports whether it worked, so callers need not read the message", async () => {
  withClipboard(async () => { throw new Error("denied"); });
  const { result } = renderHook(() => useClipboard());
  let outcome = true;
  await act(async () => { outcome = await result.current.copy("x"); });
  expect(outcome).toBe(false);
});

test("reset clears a stale outcome", async () => {
  withClipboard(async () => undefined);
  const { result } = renderHook(() => useClipboard());
  await act(async () => { await result.current.copy("x", { what: "Thing" }); });
  act(() => { result.current.reset(); });
  expect(result.current.message).toBe("");
  expect(result.current.failed).toBe(false);
});
