import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  renderSepoliaDeploymentMarkdown,
  summarizeSepoliaDeployment
} from "./summarize-sepolia-deployment.mjs";

test("summarizes top-level creates and constructor-created contracts", async () => {
  const path = await fixtureBroadcast();
  const summary = await summarizeSepoliaDeployment(path);

  assert.equal(summary.totals.topLevelCreateTransactions, 2);
  assert.equal(summary.totals.constructorCreatedContracts, 1);
  assert.equal(summary.totals.loomCreatedContracts, 3);
  assert.equal(summary.totals.gasUsed, 300000n);
  assert.equal(summary.totals.ethCostWei, 600000000000000n);
  assert.deepEqual(summary.constructorCreatedContracts, [
    {
      parent: "Factory",
      name: "Registry",
      address: "0x3333333333333333333333333333333333333333"
    }
  ]);
});

test("renders stable markdown table output", async () => {
  const summary = await summarizeSepoliaDeployment(await fixtureBroadcast());
  const markdown = renderSepoliaDeploymentMarkdown(summary);

  assert.match(markdown, /Top-level CREATE transactions: 2/u);
  assert.match(markdown, /\| Hook \| 0x1111111111111111111111111111111111111111 \| 0xaaa \| 100 \| 100000 \| 2 gwei \| 0\.0002 \|/u);
  assert.match(markdown, /Registry at 0x3333333333333333333333333333333333333333, created inside Factory/u);
});

async function fixtureBroadcast() {
  const root = await mkdtemp(join(tmpdir(), "loom-sepolia-summary-"));
  const path = join(root, "run-latest.json");
  await writeFile(path, JSON.stringify({
    chain: 11155111,
    commit: "0123456789abcdef",
    transactions: [
      {
        transactionType: "CREATE",
        contractName: "Hook",
        contractAddress: "0x1111111111111111111111111111111111111111",
        additionalContracts: []
      },
      {
        transactionType: "CREATE",
        contractName: "Factory",
        contractAddress: "0x2222222222222222222222222222222222222222",
        additionalContracts: [
          {
            contractName: "Registry",
            address: "0x3333333333333333333333333333333333333333"
          }
        ]
      }
    ],
    receipts: [
      {
        transactionHash: "0xaaa",
        blockNumber: "0x64",
        gasUsed: "0x186a0",
        effectiveGasPrice: "0x77359400"
      },
      {
        transactionHash: "0xbbb",
        blockNumber: "0x65",
        gasUsed: "0x30d40",
        effectiveGasPrice: "0x77359400"
      }
    ]
  }, null, 2));
  return path;
}
