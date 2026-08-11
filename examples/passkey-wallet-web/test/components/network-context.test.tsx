import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NetworkProvider, useNetwork } from "../../src/config/NetworkContext";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("NetworkProvider", () => {
  it("does not lose consecutive partial endpoint updates in one render", async () => {
    const user = userEvent.setup();
    render(<NetworkProvider><NetworkHarness /></NetworkProvider>);

    await user.click(screen.getByRole("button", { name: "Update endpoints" }));

    assert.equal(screen.getByTestId("rpc").textContent, "https://rpc.example/custom");
    assert.equal(screen.getByTestId("bundler").textContent, "https://bundler.example/custom");
  });
});

function NetworkHarness() {
  const { config, update } = useNetwork();
  return <>
    <button onClick={() => {
      update({ rpcUrl: "https://rpc.example/custom" });
      update({ bundlerUrl: "https://bundler.example/custom" });
    }}>Update endpoints</button>
    <output data-testid="rpc">{config.rpcUrl}</output>
    <output data-testid="bundler">{config.bundlerUrl}</output>
  </>;
}
