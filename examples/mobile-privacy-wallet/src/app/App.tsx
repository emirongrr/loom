import React from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";

import { readEnvironmentConfiguration } from "../config/environment";
import { CapabilityCard } from "../components/CapabilityCard";
import { stateReadinessGate } from "../verified/stateTransport";

const config = readEnvironmentConfiguration();

export default function App() {
  const bundlerConfigured = Boolean(config.network.bundlerUrl && config.network.entryPoint);
  const deploymentConfigured = Boolean(
    config.deployment.accountFactory && config.deployment.passkeyValidator
  );
  const stateGate = stateReadinessGate(config);

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
