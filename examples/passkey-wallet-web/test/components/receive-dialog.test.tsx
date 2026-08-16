import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ReceiveDialog } from "../../src/features/wallet/ReceiveDialog.tsx";

const lowercase = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const checksummed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "share");
});

function writeText() {
  const spy = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: spy }, configurable: true });
  return spy;
}

function open(overrides: Partial<Parameters<typeof ReceiveDialog>[0]> = {}) {
  return render(
    <ReceiveDialog address={lowercase} chainId={11_155_111} deployed onClose={() => undefined} {...overrides} />
  );
}

test("the sheet shows a scannable code and the full checksummed address at once", () => {
  open();
  const qr = screen.getByRole("img", { name: new RegExp(`QR code for ${checksummed}`, "iu") });
  expect(qr.tagName.toLowerCase()).toBe("svg");
  expect(qr.querySelector("path")?.getAttribute("d")).toBeTruthy();
  // Truncation is what address poisoning relies on; the sender needs every character.
  expect(screen.getByTestId("receive-address").textContent).toBe(checksummed);
});

test("copying yields the bare address, not the payment link", async () => {
  const spy = writeText();
  open();
  await userEvent.click(screen.getByRole("button", { name: /copy address/iu }));
  expect(spy).toHaveBeenCalledWith(checksummed);
});

test("the network is named with its chain id and the wrong-network risk is stated", () => {
  open();
  expect(screen.getByText(/sepolia · chain 11155111/iu)).toBeTruthy();
  expect(screen.getByText(/only send on sepolia/iu)).toBeTruthy();
});

test("the QR encodes the plain address so any scanner can read it", () => {
  open();
  const label = screen.getByRole("img", { name: /qr code for/iu }).getAttribute("aria-label");
  expect(label).toBe(`QR code for ${checksummed}`);
  expect(label).not.toMatch(/^ethereum:/iu);
});

test("the chain-bound EIP-681 link stays behind progressive disclosure", async () => {
  const spy = writeText();
  open();
  await userEvent.click(screen.getByText(/advanced details/iu));
  expect(screen.getByText(`ethereum:${checksummed}@11155111`)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /copy payment link/iu }));
  expect(spy).toHaveBeenCalledWith(`ethereum:${checksummed}@11155111`);
});

test("share is offered only where the platform provides it", () => {
  open();
  expect(screen.queryByRole("button", { name: /^share$/iu })).toBeNull();
  cleanup();

  Object.defineProperty(navigator, "share", { value: async () => undefined, configurable: true });
  open();
  expect(screen.getByRole("button", { name: /^share$/iu })).toBeTruthy();
});

test("a counterfactual account explains that funds are safe but cannot yet be sent", () => {
  open({ deployed: false });
  expect(screen.getByText(/funds sent here are safe at this address/iu)).toBeTruthy();
});

test("an unusable address refuses rather than showing a wrong code", () => {
  render(<ReceiveDialog address="0xnope" chainId={11_155_111} deployed onClose={() => undefined} />);
  expect(screen.getByText(/no usable receive address/iu)).toBeTruthy();
  expect(screen.queryByRole("img", { name: /qr code/iu })).toBeNull();
});

test("the sheet is an accessible dialog and a copy result is announced", async () => {
  writeText();
  open();
  const dialog = screen.getByRole("dialog", { name: /receive/iu });
  expect(dialog.getAttribute("aria-modal")).toBe("true");

  await userEvent.click(screen.getByRole("button", { name: /copy address/iu }));
  expect(await screen.findByRole("status")).toBeTruthy();
});
