import { createContext, useCallback, useContext, useMemo, useRef, useState, type PropsWithChildren } from "react";
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
  const current = useRef(config);
  // Deliberately not a functional state update: `saveNetworkConfig` rejects an
  // unusable endpoint, and a throw inside a state updater surfaces during
  // render rather than to the caller that asked for the change. The settings
  // screen needs the rejection in its own hands so it can keep the draft and
  // say which field was refused. The ref preserves functional-update semantics
  // when two partial updates happen before React renders again.
  const update = useCallback((next: Partial<NetworkConfig>) => {
    const saved = saveNetworkConfig({ ...current.current, ...next });
    current.current = saved;
    setConfig(saved);
  }, []);
  const reset = useCallback(() => {
    const saved = saveNetworkConfig(DEFAULT_NETWORK);
    current.current = saved;
    setConfig(saved);
  }, []);
  const value = useMemo(() => ({ config, update, reset }), [config, update, reset]);
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkContextValue {
  const value = useContext(NetworkContext);
  if (!value) throw new Error("NetworkProvider is missing");
  return value;
}
