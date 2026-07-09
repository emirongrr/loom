import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_BROADCAST_PATH = "broadcast/DeploySepolia.s.sol/11155111/run-latest.json";
const WEI_PER_ETH = 10n ** 18n;
const WEI_PER_GWEI = 10n ** 9n;

export async function summarizeSepoliaDeployment(path = DEFAULT_BROADCAST_PATH) {
  const broadcast = JSON.parse(await readFile(path, "utf8"));
  const transactions = Array.isArray(broadcast.transactions) ? broadcast.transactions : [];
  const receipts = Array.isArray(broadcast.receipts) ? broadcast.receipts : [];

  const createRows = transactions.flatMap((transaction, index) => {
    if (transaction.transactionType !== "CREATE") return [];
    const receipt = receipts[index];
    if (!receipt) throw new Error(`missing receipt for transaction ${index}`);
    const gasUsed = parseQuantity(receipt.gasUsed, `receipts[${index}].gasUsed`);
    const effectiveGasPrice = parseQuantity(receipt.effectiveGasPrice, `receipts[${index}].effectiveGasPrice`);
    const ethCostWei = gasUsed * effectiveGasPrice;
    return [{
      name: requireString(transaction.contractName, `transactions[${index}].contractName`),
      address: requireString(transaction.contractAddress, `transactions[${index}].contractAddress`),
      txHash: requireString(receipt.transactionHash, `receipts[${index}].transactionHash`),
      block: parseQuantity(receipt.blockNumber, `receipts[${index}].blockNumber`),
      gasUsed,
      effectiveGasPrice,
      ethCostWei
    }];
  });

  const constructorCreatedContracts = transactions.flatMap((transaction, index) =>
    (transaction.additionalContracts ?? []).map((contract, innerIndex) => ({
      parent: requireString(transaction.contractName, `transactions[${index}].contractName`),
      name: requireString(contract.contractName, `transactions[${index}].additionalContracts[${innerIndex}].contractName`),
      address: requireString(contract.address, `transactions[${index}].additionalContracts[${innerIndex}].address`)
    }))
  );

  return Object.freeze({
    chain: broadcast.chain,
    commit: broadcast.commit,
    rows: Object.freeze(createRows),
    constructorCreatedContracts: Object.freeze(constructorCreatedContracts),
    totals: Object.freeze({
      topLevelCreateTransactions: createRows.length,
      constructorCreatedContracts: constructorCreatedContracts.length,
      loomCreatedContracts: createRows.length + constructorCreatedContracts.length,
      gasUsed: createRows.reduce((total, row) => total + row.gasUsed, 0n),
      ethCostWei: createRows.reduce((total, row) => total + row.ethCostWei, 0n)
    })
  });
}

export function renderSepoliaDeploymentMarkdown(summary) {
  const rows = [
    "| Contract | Address | Tx hash | Block | Gas used | Gas price | ETH cost |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: |",
    ...summary.rows.map(row =>
      `| ${row.name} | ${row.address} | ${row.txHash} | ${row.block} | ${row.gasUsed} | ${formatGwei(row.effectiveGasPrice)} gwei | ${formatEth(row.ethCostWei)} |`
    )
  ];

  const constructorRows = summary.constructorCreatedContracts.length === 0
    ? ["- None recorded in `additionalContracts`."]
    : summary.constructorCreatedContracts.map(contract =>
      `- ${contract.name} at ${contract.address}, created inside ${contract.parent}.`
    );

  return `${[
    "# Sepolia Deployment Broadcast Summary",
    "",
    `- Chain: ${summary.chain ?? "unknown"}`,
    `- Source commit: ${summary.commit ?? "unknown"}`,
    `- Top-level CREATE transactions: ${summary.totals.topLevelCreateTransactions}`,
    `- Constructor-created contracts: ${summary.totals.constructorCreatedContracts}`,
    `- Loom-created contracts: ${summary.totals.loomCreatedContracts}`,
    `- Total deploy gas: ${summary.totals.gasUsed}`,
    `- Total ETH cost: ${formatEth(summary.totals.ethCostWei)}`,
    "",
    "## Top-level CREATE Transactions",
    "",
    ...rows,
    "",
    "## Constructor-created Contracts",
    "",
    ...constructorRows
  ].join("\n")}\n`;
}

function parseQuantity(value, label) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a quantity`);
  if (/^0x[0-9a-fA-F]+$/u.test(value)) return BigInt(value);
  if (/^[0-9]+$/u.test(value)) return BigInt(value);
  throw new Error(`${label} must be a hex or decimal quantity`);
}

function requireString(value, label) {
  if (!value || typeof value !== "string") throw new Error(`${label} is required`);
  return value;
}

function formatGwei(wei) {
  const whole = wei / WEI_PER_GWEI;
  const fraction = wei % WEI_PER_GWEI;
  return trimDecimal(`${whole}.${fraction.toString().padStart(9, "0")}`, 9);
}

function formatEth(wei) {
  const whole = wei / WEI_PER_ETH;
  const fraction = wei % WEI_PER_ETH;
  return trimDecimal(`${whole}.${fraction.toString().padStart(18, "0")}`, 18);
}

function trimDecimal(value, precision) {
  const [whole, fraction] = value.split(".");
  const trimmed = fraction.slice(0, precision).replace(/0+$/u, "");
  return trimmed.length === 0 ? whole : `${whole}.${trimmed}`;
}

async function main() {
  const [path = DEFAULT_BROADCAST_PATH] = process.argv.slice(2);
  const summary = await summarizeSepoliaDeployment(path);
  process.stdout.write(renderSepoliaDeploymentMarkdown(summary));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
