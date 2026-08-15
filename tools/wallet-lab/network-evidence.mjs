const METHOD_PROFILES = Object.freeze({
  eth_chainId: ["environment-verification", "required-for-observed-flow", "Confirms that the RPC is connected to the deployment's expected chain."],
  eth_supportedEntryPoints: ["environment-verification", "required-for-observed-flow", "Confirms that the bundler supports the deployment's EntryPoint."],
  eth_getCode: ["deployment-verification", "required-for-observed-flow", "Reads runtime bytecode to distinguish deployed accounts and verify trusted contracts."],
  eth_getBalance: ["state-verification", "independent-check", "Reads native balance before or after the operation so the expected value movement can be checked."],
  eth_call: ["account-state", "required-for-observed-flow", "Reads account or EntryPoint state without changing the chain, commonly nonce or configuration."],
  eth_getBlockByNumber: ["fee-preparation", "required-for-observed-flow", "Reads the current block context used for fee selection and finality checks."],
  eth_gasPrice: ["fee-preparation", "required-for-observed-flow", "Reads a current gas-price reference for the operation fee limits."],
  eth_maxPriorityFeePerGas: ["fee-preparation", "required-for-observed-flow", "Reads a priority-fee reference for the operation fee limits."],
  eth_estimateUserOperationGas: ["simulation", "required-for-observed-flow", "Asks the bundler to simulate the UserOperation and return its gas limits before signing and submission."],
  eth_sendUserOperation: ["submission", "required-for-observed-flow", "Publishes the signed UserOperation to the bundler for EntryPoint inclusion."],
  eth_getUserOperationReceipt: ["inclusion", "required-for-observed-flow", "Polls for the ERC-4337 receipt that binds the operation hash, sender, and enclosing transaction."],
  eth_getTransactionReceipt: ["confirmation", "independent-check", "Reads the enclosing chain transaction receipt to verify that execution succeeded on chain."],
  eth_blockNumber: ["finality", "independent-check", "Reads the current head to prove that a later block exists after inclusion."],
  pimlico_getUserOperationGasPrice: ["fee-preparation", "provider-specific", "Queries Pimlico's fee recommendation used by this client run. This is a provider extension, not a Loom or ERC-4337 requirement."]
});

export function annotateNetworkExchange(exchange, operation) {
  const method = exchange?.request?.method ?? "unknown";
  const [stage, requirement, explanation] = METHOD_PROFILES[method] ?? ["other", "observed-only", "This captured JSON-RPC method is preserved as observed evidence without claiming that Loom requires it."];
  return { ...exchange, operation, stage, requirement, explanation };
}
