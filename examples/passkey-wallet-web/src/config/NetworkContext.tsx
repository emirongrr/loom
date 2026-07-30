import { createContext, useCallback, useContext, useMemo, useState, type PropsWithChildren } from "react";
import { DEFAULT_NETWORK, loadNetworkConfig, saveNetworkConfig, type NetworkConfig } from "./network";

interface NetworkContextValue {
  readonly config: NetworkConfig;
  update(next: Partial<NetworkConfig>): void;
  reset(): void;
}

const NetworkContext = createContext<NetworkContextValue | null>(null);

export function NetworkProvider({ children }: PropsWithChildren) {
  const [config, setConfig] = useState<NetworkConfig>(() => {
    try { return loadNetworkConfig(); } catch { return DEFAULT_NETWORK; }
  });
  const update = useCallback((next: Partial<NetworkConfig>) => {
    setConfig(current => saveNetworkConfig({ ...current, ...next }));
  }, []);
  const reset = useCallback(() => setConfig(saveNetworkConfig(DEFAULT_NETWORK)), []);
  const value = useMemo(() => ({ config, update, reset }), [config, update, reset]);
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkContextValue {
  const value = useContext(NetworkContext);
  if (!value) throw new Error("NetworkProvider is missing");
  return value;
}
