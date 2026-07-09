import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { CapabilityCard } from "../components/CapabilityCard";
import { GateList } from "../components/GateList";
import { colors } from "../theme/colors";
import type { MobileWalletConfiguration, ReleaseGate } from "../types/wallet";
import { stateReadinessGate } from "../verified/stateTransport";

// Full, honest capability status. The home screen shows only a compact count;
// this screen keeps every gate visible with its reason — nothing is softened.
export function StatusScreen({
  config,
  configGates,
  manifestGates,
  screenPrivacy
}: {
  readonly config: MobileWalletConfiguration;
  readonly configGates: readonly ReleaseGate[];
  readonly manifestGates: readonly ReleaseGate[];
  readonly screenPrivacy: "enabled" | "unavailable" | "pending";
}) {
  const bundlerConfigured = Boolean(config.network.bundlerUrl && config.network.entryPoint);
  const deploymentConfigured = Boolean(config.deployment.accountFactory && config.deployment.passkeyValidator);
  const stateGate = stateReadinessGate(config);
  const p256Configured = config.deployment.p256VerifierMode !== "not-configured";
  const p256Body =
    config.deployment.p256VerifierMode === "native-precompile"
      ? "P-256 verification uses the protocol-level native precompile for this chain."
      : config.deployment.p256VerifierMode === "fallback-contract"
        ? "P-256 verification uses a fallback contract; release evidence must match the audited verifier codehash."
        : "P-256 verifier mode is not configured. Do not deploy passkey accounts until the verifier mode is reviewed.";

  return (
    <View style={styles.screen}>
      <Text style={styles.heading}>Status</Text>

      <CapabilityCard
        title="Configuration"
        status={configGates.length === 0 ? "configured" : "not-configured"}
        body={
          configGates.length === 0
            ? "Chain, relying-party id, origin, and deployment addresses are all explicitly set."
            : "Required configuration is incomplete. Every missing value is listed below; nothing is assumed."
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
      <CapabilityCard title="P-256 verifier" status={p256Configured ? "configured" : "not-configured"} body={p256Body} />
      <CapabilityCard
        title="Deployment verification"
        status={
          !config.deployment.accountFactory
            ? "not-configured"
            : manifestGates.length === 0
              ? "verified"
              : "blocked"
        }
        body={
          !config.deployment.accountFactory
            ? "No deployment configured yet. Deploy Loom and run npm run deploy:connect."
            : manifestGates.length === 0
              ? "Configured addresses match the committed deployment manifest generated from the verified broadcast."
              : "Configured addresses do NOT match the committed manifest. Details below — do not create accounts against unverified addresses."
        }
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

      {manifestGates.length > 0 && (
        <>
          <Text style={styles.subheading}>Deployment verification</Text>
          <GateList gates={manifestGates} />
        </>
      )}

      {configGates.length > 0 && (
        <>
          <Text style={styles.subheading}>Blocking configuration</Text>
          <GateList gates={configGates} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { gap: 12 },
  heading: { color: colors.text, fontSize: 24, fontWeight: "700", marginBottom: 4 },
  subheading: { color: colors.textDim, fontSize: 14, fontWeight: "600", marginTop: 8 }
});
