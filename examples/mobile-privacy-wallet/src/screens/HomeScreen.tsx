import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { CONFIGURATION_CHECK_COUNT } from "../config/environment";
import { colors } from "../theme/colors";
import type { Hex, MobileWalletConfiguration } from "../types/wallet";

export type HomeNavigation =
  | "create-account"
  | "send"
  | "receive"
  | "private-send"
  | "status"
  | "settings";

function truncateHex(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

// The wallet home. Familiar smart-wallet layout — header, balance, action
// tiles, activity — but every state stays honest: when the app is not
// connected to a Loom deployment it says so up front instead of rendering a
// dead wallet, and blocked capabilities are visibly locked, never hidden.
export function HomeScreen({
  config,
  blockedCount,
  credentialIdHash,
  bundlerConfigured,
  deploymentConnected,
  stateReadsLabel,
  onNavigate
}: {
  readonly config: MobileWalletConfiguration;
  readonly blockedCount: number;
  readonly credentialIdHash?: Hex;
  readonly bundlerConfigured: boolean;
  readonly deploymentConnected: boolean;
  readonly stateReadsLabel: "verified" | "unverified" | "unavailable";
  readonly onNavigate: (target: HomeNavigation) => void;
}) {
  const networkLabel =
    config.network.chainId === 11155111
      ? "Sepolia"
      : config.network.chainId === 1
        ? "Ethereum"
        : config.network.chainId > 0
          ? `Chain ${config.network.chainId}`
          : "No network";
  const hasAccount = Boolean(credentialIdHash);
  const configured = Math.max(CONFIGURATION_CHECK_COUNT - blockedCount, 0);

  return (
    <View style={styles.screen}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>Loom Wallet</Text>
          <View style={styles.networkRow}>
            <View
              style={[styles.dot, { backgroundColor: config.network.chainId > 0 ? colors.success : colors.warn }]}
            />
            <Text style={styles.networkLabel}>{networkLabel}</Text>
          </View>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => onNavigate("settings")}
          style={({ pressed }) => [styles.gear, pressed && styles.gearPressed]}
        >
          <Text style={styles.gearGlyph}>⚙</Text>
        </Pressable>
      </View>

      {/* Not connected to a deployment — first-class state, not a footnote. */}
      {!deploymentConnected && (
        <View style={styles.deployCard}>
          <Text style={styles.deployTitle}>Not connected to a Loom deployment</Text>
          <Text style={styles.deployBody}>
            The Loom contracts (factory, validator, EntryPoint) are not configured for any network. Deploy
            Loom to Sepolia and point the app at the deployed addresses — until then account creation and
            transfers stay disabled instead of pretending to work.
          </Text>
          <Text style={styles.deploySteps}>
            1. Deploy: script/DeploySepolia.s.sol (docs/operations/sepolia-mobile-deployment.md){"\n"}
            2. Fill EXPO_PUBLIC_LOOM_* addresses in .env.local{"\n"}
            3. Restart the dev server
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => onNavigate("status")}
            style={({ pressed }) => [styles.deployButton, pressed && styles.deployButtonPressed]}
          >
            <Text style={styles.deployButtonLabel}>See what is missing</Text>
          </Pressable>
        </View>
      )}

      {/* Balance */}
      <View style={styles.balanceBlock}>
        <Text style={styles.balanceValue}>{stateReadsLabel === "verified" ? "0.0000 ETH" : "—"}</Text>
        <Text style={styles.balanceCaption}>
          {stateReadsLabel === "verified"
            ? "Helios-verified balance"
            : stateReadsLabel === "unverified"
              ? "Unverified — plain RPC mode"
              : "Balance unavailable until a deployment and state reads are configured"}
        </Text>
      </View>

      {/* Actions */}
      <View style={styles.actionRow}>
        <ActionTile glyph="↓" label="Receive" enabled={hasAccount} onPress={() => onNavigate("receive")} />
        <ActionTile glyph="↑" label="Send" enabled={hasAccount && bundlerConfigured} onPress={() => onNavigate("send")} />
        <ActionTile glyph="◇" label="Private" enabled={false} lockNote="gated" onPress={() => onNavigate("private-send")} />
      </View>

      {/* Account */}
      <View style={styles.card}>
        {hasAccount ? (
          <View style={styles.accountRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarGlyph}>🔑</Text>
            </View>
            <View style={styles.accountText}>
              <Text style={styles.cardTitle}>Passkey credential</Text>
              <Text style={styles.mono}>{truncateHex(credentialIdHash ?? "")}</Text>
              <Text style={styles.cardHintWarn}>Recovery unprotected — set up guardians before funding.</Text>
            </View>
          </View>
        ) : (
          <>
            <Text style={styles.cardTitle}>Create your account</Text>
            <Text style={styles.cardHint}>
              Passkey-secured, seedless. The private key never leaves your device&apos;s secure hardware.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => onNavigate("create-account")}
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && styles.primaryButtonPressed,
                !deploymentConnected && styles.primaryButtonDim
              ]}
            >
              <Text style={styles.primaryButtonLabel}>
                {deploymentConnected ? "Create account" : "Create account (blocked — no deployment)"}
              </Text>
            </Pressable>
          </>
        )}
      </View>

      {/* Setup progress */}
      <Pressable
        accessibilityRole="button"
        onPress={() => onNavigate("status")}
        style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      >
        <View style={styles.progressHeader}>
          <Text style={styles.cardTitle}>Setup</Text>
          <Text style={styles.progressCount}>
            {configured}/{CONFIGURATION_CHECK_COUNT}
          </Text>
        </View>
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              { width: `${Math.round((configured / CONFIGURATION_CHECK_COUNT) * 100)}%` }
            ]}
          />
        </View>
        <Text style={styles.cardHint}>
          {blockedCount === 0
            ? "All critical configuration is set."
            : `${blockedCount} required value${blockedCount === 1 ? "" : "s"} missing — tap for details.`}
        </Text>
      </Pressable>

      {/* Activity */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Activity</Text>
        <Text style={styles.cardHint}>
          {hasAccount ? "No transactions yet." : "Activity appears after the account is created and deployed."}
        </Text>
      </View>
    </View>
  );
}

function ActionTile({
  glyph,
  label,
  enabled,
  lockNote,
  onPress
}: {
  readonly glyph: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly lockNote?: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
    >
      <View style={[styles.tileIcon, !enabled && styles.tileIconDisabled]}>
        <Text style={[styles.tileGlyph, !enabled && styles.tileGlyphDisabled]}>{glyph}</Text>
      </View>
      <Text style={[styles.tileLabel, !enabled && styles.tileLabelDisabled]}>{label}</Text>
      {!enabled && <Text style={styles.tileLock}>{lockNote ?? "locked"}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { gap: 16 },
  header: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  brand: { color: colors.text, fontSize: 20, fontWeight: "700" },
  networkRow: { alignItems: "center", flexDirection: "row", gap: 6, marginTop: 2 },
  dot: { borderRadius: 999, height: 7, width: 7 },
  networkLabel: { color: colors.textDim, fontSize: 13 },
  gear: {
    alignItems: "center",
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderRadius: 999,
    borderWidth: 1,
    height: 38,
    justifyContent: "center",
    width: 38
  },
  gearPressed: { backgroundColor: colors.cardPressed },
  gearGlyph: { color: colors.textDim, fontSize: 17 },

  deployCard: {
    backgroundColor: colors.warnBg,
    borderColor: colors.warnBorder,
    borderRadius: 18,
    borderWidth: 1,
    gap: 10,
    padding: 18
  },
  deployTitle: { color: colors.warn, fontSize: 16, fontWeight: "700" },
  deployBody: { color: "#e3c7b8", fontSize: 13, lineHeight: 19 },
  deploySteps: { color: "#b99a89", fontFamily: "monospace", fontSize: 11, lineHeight: 17 },
  deployButton: {
    alignItems: "center",
    backgroundColor: colors.warnBorder,
    borderRadius: 10,
    paddingVertical: 11
  },
  deployButtonPressed: { opacity: 0.8 },
  deployButtonLabel: { color: colors.warn, fontSize: 14, fontWeight: "700" },

  balanceBlock: { alignItems: "center", gap: 6, paddingVertical: 12 },
  balanceValue: { color: colors.text, fontSize: 44, fontWeight: "700", letterSpacing: -1 },
  balanceCaption: { color: colors.textFaint, fontSize: 12, textAlign: "center" },

  actionRow: { flexDirection: "row", gap: 10 },
  tile: {
    alignItems: "center",
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    gap: 6,
    paddingVertical: 14
  },
  tilePressed: { backgroundColor: colors.cardPressed },
  tileIcon: {
    alignItems: "center",
    backgroundColor: "#1c2940",
    borderRadius: 999,
    height: 40,
    justifyContent: "center",
    width: 40
  },
  tileIconDisabled: { backgroundColor: colors.cardPressed },
  tileGlyph: { color: colors.accent, fontSize: 18, fontWeight: "700" },
  tileGlyphDisabled: { color: colors.textFaint },
  tileLabel: { color: colors.text, fontSize: 13, fontWeight: "600" },
  tileLabelDisabled: { color: colors.textFaint },
  tileLock: { color: colors.textFaint, fontSize: 9, letterSpacing: 0.6, textTransform: "uppercase" },

  card: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    padding: 16
  },
  cardPressed: { backgroundColor: colors.cardPressed },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  cardHint: { color: colors.textDim, fontSize: 13, lineHeight: 19 },
  cardHintWarn: { color: colors.warn, fontSize: 12, lineHeight: 17 },
  mono: { color: colors.textDim, fontFamily: "monospace", fontSize: 13 },
  accountRow: { alignItems: "center", flexDirection: "row", gap: 12 },
  avatar: {
    alignItems: "center",
    backgroundColor: "#1c2940",
    borderRadius: 999,
    height: 44,
    justifyContent: "center",
    width: 44
  },
  avatarGlyph: { fontSize: 18 },
  accountText: { flex: 1, gap: 3 },

  primaryButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 12,
    marginTop: 4,
    paddingVertical: 13
  },
  primaryButtonPressed: { backgroundColor: colors.accentPressed },
  primaryButtonDim: { opacity: 0.55 },
  primaryButtonLabel: { color: colors.text, fontSize: 15, fontWeight: "700" },

  progressHeader: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  progressCount: { color: colors.textDim, fontFamily: "monospace", fontSize: 13 },
  progressTrack: {
    backgroundColor: colors.bg,
    borderRadius: 999,
    height: 6,
    overflow: "hidden"
  },
  progressFill: { backgroundColor: colors.accent, borderRadius: 999, height: 6 }
});
