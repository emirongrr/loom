import React from "react";
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";

import { configurationReadiness, readEnvironmentConfiguration } from "../config/environment";
import { CapabilityCard } from "../components/CapabilityCard";
import { createScreenPrivacyShield } from "../platform/screenPrivacy";
import { CreateAccountScreen } from "../screens/CreateAccountScreen";
import { PrivateSendScreen } from "../screens/PrivateSendScreen";
import { stateReadinessGate } from "../verified/stateTransport";

const config = readEnvironmentConfiguration();

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
        // Fail closed: the wallet keeps running, but the UI must show that
        // screenshots and app-switcher snapshots are NOT protected.
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

const SECTIONS = ["Status", "Create account", "Private send"] as const;
type Section = (typeof SECTIONS)[number];

export default function App() {
  const configGates = configurationReadiness(config);
  const screenPrivacy = useScreenPrivacy();
  const [section, setSection] = React.useState<Section>("Status");
  const bundlerConfigured = Boolean(config.network.bundlerUrl && config.network.entryPoint);
  const deploymentConfigured = Boolean(
    config.deployment.accountFactory && config.deployment.passkeyValidator
  );
  const stateGate = stateReadinessGate(config);
  const p256Configured = config.deployment.p256VerifierMode !== "not-configured";
  const p256Body =
    config.deployment.p256VerifierMode === "native-precompile"
      ? "P-256 verification uses the protocol-level native precompile for this chain."
      : config.deployment.p256VerifierMode === "fallback-contract"
        ? "P-256 verification uses a fallback contract; release evidence must match the audited verifier codehash."
        : "P-256 verifier mode is not configured. Do not deploy passkey accounts until the verifier mode is reviewed.";

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>Loom example client</Text>
          <Text style={styles.title}>Mobile Privacy Wallet</Text>
          <Text style={styles.body}>
            A passkey-first, self-custody mobile wallet boilerplate with explicit
            infrastructure, progressive recovery, and gated privacy.
          </Text>
        </View>

        <View style={styles.tabs}>
          {SECTIONS.map(name => (
            <Pressable
              accessibilityRole="button"
              key={name}
              onPress={() => setSection(name)}
              style={[styles.tab, section === name && styles.tabActive]}
            >
              <Text style={[styles.tabLabel, section === name && styles.tabLabelActive]}>{name}</Text>
            </Pressable>
          ))}
        </View>

        {section === "Create account" && <CreateAccountScreen config={config} />}
        {section === "Private send" && <PrivateSendScreen config={config} />}

        {section === "Status" && (
          <>
        <CapabilityCard
          title="Configuration"
          status={configGates.length === 0 ? "configured" : "not-configured"}
          body={
            configGates.length === 0
              ? "Chain, relying-party id, origin, and deployment addresses are all explicitly set."
              : `Incomplete: ${configGates.map(gate => gate.id).join(", ")}. No value is assumed; account creation is blocked until these are set.`
          }
        />
        <CapabilityCard
          title="Screen privacy"
          status={screenPrivacy === "enabled" ? "configured" : screenPrivacy === "pending" ? "pending" : "requires-device"}
          body={
            screenPrivacy === "enabled"
              ? "Android blocks screenshots and recents thumbnails (FLAG_SECURE); iOS covers the app-switcher snapshot. iOS cannot block screenshots."
              : "The native screen privacy module is not active; screenshots and app-switcher snapshots are unprotected in this build."
          }
        />
        <CapabilityCard
          title="Passkey account"
          status="requires-device"
          body="Creates a platform passkey through the native module. No seed phrase and no hosted signer."
        />
        <CapabilityCard
          title="Account deployment"
          status={deploymentConfigured && bundlerConfigured ? "configured" : "not-configured"}
          body="Requires explicit factory, validator, EntryPoint, and bundler configuration."
        />
        <CapabilityCard
          title="P-256 verifier"
          status={p256Configured ? "configured" : "not-configured"}
          body={p256Body}
        />
        <CapabilityCard
          title="Verified state reads"
          status={stateGate.status === "passed" ? "configured" : stateGate.status}
          body={
            config.verifiedState.mode === "helios"
              ? "Helios verifies state from user-supplied execution and consensus transports after a checkpoint sync."
              : stateGate.summary
          }
        />
        <CapabilityCard
          title="Recovery"
          status="progressive"
          body="Guardianless onboarding is allowed, but the UI must show unprotected recovery until setup is complete."
        />
        <CapabilityCard
          title="Private send"
          status="gated"
          body="Railgun private transfer is disabled until privacy adapter evidence passes."
        />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#080b10"
  },
  container: {
    gap: 16,
    padding: 24
  },
  header: {
    gap: 10,
    marginBottom: 8
  },
  tabs: {
    flexDirection: "row",
    gap: 8
  },
  tab: {
    backgroundColor: "#111722",
    borderColor: "#243044",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8
  },
  tabActive: {
    backgroundColor: "#1c2d42",
    borderColor: "#3c5a85"
  },
  tabLabel: {
    color: "#8ea0b8",
    fontSize: 13,
    fontWeight: "600"
  },
  tabLabelActive: {
    color: "#cfe2ff"
  },
  eyebrow: {
    color: "#8ea0b8",
    fontSize: 13,
    letterSpacing: 1.4,
    textTransform: "uppercase"
  },
  title: {
    color: "#f7f9fc",
    fontSize: 34,
    fontWeight: "700"
  },
  body: {
    color: "#bac6d6",
    fontSize: 16,
    lineHeight: 24
  }
});
