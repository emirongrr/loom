import React from "react";
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";

import { configurationReadiness, readEnvironmentConfiguration } from "../config/environment";
import {
  activateBundlerProfile,
  addBundlerProfile,
  applyEndpointOverrides,
  loadBundlerProfiles,
  loadEndpointOverrides,
  removeBundlerProfile,
  saveEndpointOverride,
  type BundlerProfile,
  type EndpointOverrides
} from "../config/runtimeOverrides";
import { GateList } from "../components/GateList";
import { deploymentManifestGates } from "../loom/deployment/connectedManifest";
import { createNativeSecureStoreBackend } from "../platform/nativeSecureStoreBackend";
import { createScreenPrivacyShield } from "../platform/screenPrivacy";
import { createSecureLocalStore, type SecureLocalStore } from "../platform/secureStore";
import { CreateAccountScreen } from "../screens/CreateAccountScreen";
import { HomeScreen, type HomeNavigation } from "../screens/HomeScreen";
import { PrivateSendScreen } from "../screens/PrivateSendScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { StatusScreen } from "../screens/StatusScreen";
import { colors } from "../theme/colors";
import type { Hex } from "../types/wallet";
import { stateReadinessGate } from "../verified/stateTransport";

const baseConfig = readEnvironmentConfiguration();

type ScreenPrivacyStatus = "enabled" | "unavailable" | "pending";

function useScreenPrivacy(): ScreenPrivacyStatus {
  const [status, setStatus] = React.useState<ScreenPrivacyStatus>("pending");

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await createScreenPrivacyShield().enable();
        if (!cancelled) {
          setStatus("enabled");
        }
      } catch {
        // Fail closed: the wallet keeps running, but the status screen must
        // show that screenshots and app-switcher snapshots are NOT protected.
        if (!cancelled) {
          setStatus("unavailable");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}

function useSecureStore(): SecureLocalStore | undefined {
  return React.useMemo(() => {
    try {
      return createSecureLocalStore({ backend: createNativeSecureStoreBackend() });
    } catch {
      // No encrypted storage in this build: nothing is persisted, ever.
      return undefined;
    }
  }, []);
}

const TABS = ["Home", "Status", "Settings"] as const;
type Tab = (typeof TABS)[number];
type Overlay = "create-account" | "private-send" | "receive" | "send" | undefined;

export default function App() {
  const screenPrivacy = useScreenPrivacy();
  const store = useSecureStore();
  const [tab, setTab] = React.useState<Tab>("Home");
  const [overlay, setOverlay] = React.useState<Overlay>(undefined);
  const [overrides, setOverrides] = React.useState<EndpointOverrides>({});
  const [bundlerProfiles, setBundlerProfiles] = React.useState<readonly BundlerProfile[]>([]);
  const [credentialIdHash, setCredentialIdHash] = React.useState<Hex | undefined>();

  React.useEffect(() => {
    if (!store) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [loaded, profiles, storedCredential] = await Promise.all([
          loadEndpointOverrides(store),
          loadBundlerProfiles(store),
          store.get("loom.credentialIdHash")
        ]);
        if (!cancelled) {
          setOverrides(loaded);
          setBundlerProfiles(profiles);
          if (storedCredential) {
            setCredentialIdHash(storedCredential as Hex);
          }
        }
      } catch {
        // Reads fail closed to "nothing stored"; the UI simply shows the
        // pre-account state instead of guessing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store]);

  const config = applyEndpointOverrides(baseConfig, overrides);
  const configGates = configurationReadiness(config);
  const stateGate = stateReadinessGate(config);
  const stateReadsLabel =
    stateGate.status === "passed" ? "verified" : config.verifiedState.mode === "rpc" && config.network.rpcUrl ? "unverified" : "unavailable";
  const bundlerConfigured = Boolean(config.network.bundlerUrl && config.network.entryPoint);

  // Connected means: addresses configured AND they match the manifest that
  // scripts/connect-deployment.mjs verified against the chain.
  const manifestGates = deploymentManifestGates(config);
  const deploymentConnected =
    config.network.chainId > 0 &&
    Boolean(config.deployment.accountFactory && config.deployment.passkeyValidator && config.network.entryPoint) &&
    manifestGates.length === 0;

  const handleNavigate = React.useCallback((target: HomeNavigation) => {
    if (target === "status") {
      setTab("Status");
      return;
    }
    if (target === "settings") {
      setTab("Settings");
      return;
    }
    setOverlay(target);
  }, []);

  const handleRegistered = React.useCallback(
    (hash: Hex) => {
      setCredentialIdHash(hash);
      if (store) {
        store.set("loom.credentialIdHash", hash).catch(() => {
          // Persisting is best-effort; the in-memory session still works and
          // nothing outside the allowlisted key is ever written.
        });
      }
    },
    [store]
  );

  const handleSaveEndpoint = React.useCallback(
    async (endpoint: "bundler" | "rpc", value: string): Promise<string | undefined> => {
      if (!store) {
        return "Encrypted storage is unavailable.";
      }
      try {
        await saveEndpointOverride(store, endpoint, value);
        setOverrides(await loadEndpointOverrides(store));
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [store]
  );

  const handleAddBundlerProfile = React.useCallback(
    async (label: string, url: string): Promise<string | undefined> => {
      if (!store) {
        return "Encrypted storage is unavailable.";
      }
      try {
        setBundlerProfiles(await addBundlerProfile(store, label, url));
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [store]
  );

  const handleRemoveBundlerProfile = React.useCallback(
    async (id: string) => {
      if (!store) {
        return;
      }
      setBundlerProfiles(await removeBundlerProfile(store, id));
    },
    [store]
  );

  const handleActivateBundlerProfile = React.useCallback(
    async (id: string) => {
      if (!store) {
        return;
      }
      await activateBundlerProfile(store, id);
      setOverrides(await loadEndpointOverrides(store));
    },
    [store]
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        {overlay ? (
          <View style={styles.overlay}>
            <Pressable accessibilityRole="button" onPress={() => setOverlay(undefined)} style={styles.back}>
              <Text style={styles.backLabel}>‹ Back</Text>
            </Pressable>
            {overlay === "create-account" && (
              <CreateAccountScreen config={config} onRegistered={handleRegistered} />
            )}
            {overlay === "private-send" && <PrivateSendScreen config={config} />}
            {overlay === "receive" && (
              <View style={styles.stub}>
                <Text style={styles.stubTitle}>Receive</Text>
                <Text style={styles.stubBody}>
                  The account address becomes available after on-chain deployment. Until then there is no
                  address to receive to — this screen will show it, verified, once deployment completes.
                </Text>
              </View>
            )}
            {overlay === "send" && (
              <View style={styles.stub}>
                <Text style={styles.stubTitle}>Send</Text>
                <GateList
                  gates={[
                    {
                      id: "send.requires.deployment",
                      title: "Sending is not available yet",
                      status: "blocked",
                      summary: bundlerConfigured
                        ? "The account must be deployed on-chain before it can send. Complete account creation first."
                        : "A bundler and EntryPoint are required before any transaction can be submitted. Configure a bundler in Settings."
                    }
                  ]}
                />
              </View>
            )}
          </View>
        ) : (
          <>
            {tab === "Home" && (
              <HomeScreen
                blockedCount={configGates.length}
                bundlerConfigured={bundlerConfigured}
                config={config}
                credentialIdHash={credentialIdHash}
                deploymentConnected={deploymentConnected}
                onNavigate={handleNavigate}
                stateReadsLabel={stateReadsLabel}
              />
            )}
            {tab === "Status" && (
              <StatusScreen
                config={config}
                configGates={configGates}
                manifestGates={manifestGates}
                screenPrivacy={screenPrivacy}
              />
            )}
            {tab === "Settings" && (
              <SettingsScreen
                bundlerProfiles={bundlerProfiles}
                envBundlerUrl={baseConfig.network.bundlerUrl}
                envRpcUrl={baseConfig.network.rpcUrl}
                onActivateBundlerProfile={handleActivateBundlerProfile}
                onAddBundlerProfile={handleAddBundlerProfile}
                onRemoveBundlerProfile={handleRemoveBundlerProfile}
                onSave={handleSaveEndpoint}
                overrides={overrides}
                storageAvailable={Boolean(store)}
              />
            )}
          </>
        )}
      </ScrollView>

      {!overlay && (
        <View style={styles.tabBar}>
          {TABS.map(name => (
            <Pressable
              accessibilityRole="button"
              key={name}
              onPress={() => setTab(name)}
              style={styles.tabItem}
            >
              <Text style={[styles.tabLabel, tab === name && styles.tabLabelActive]}>{name}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: colors.bg, flex: 1 },
  container: { gap: 16, padding: 20, paddingBottom: 32 },
  overlay: { gap: 14 },
  back: { alignSelf: "flex-start", paddingVertical: 4 },
  backLabel: { color: colors.accent, fontSize: 16, fontWeight: "600" },
  stub: { gap: 10 },
  stubTitle: { color: colors.text, fontSize: 24, fontWeight: "700" },
  stubBody: { color: colors.textDim, fontSize: 14, lineHeight: 21 },
  tabBar: {
    backgroundColor: colors.bg,
    borderTopColor: colors.cardBorder,
    borderTopWidth: 1,
    flexDirection: "row",
    paddingBottom: 18,
    paddingTop: 10
  },
  tabItem: { alignItems: "center", flex: 1, paddingVertical: 4 },
  tabLabel: { color: colors.textFaint, fontSize: 13, fontWeight: "600" },
  tabLabelActive: { color: colors.text }
});
