import React from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { colors } from "../theme/colors";
import type { EndpointOverrides } from "../config/runtimeOverrides";

// Runtime infrastructure settings. Only replaceable transports are editable —
// any ERC-4337 bundler and any RPC endpoint can be plugged in here without a
// rebuild. Chain identity, contract addresses, and passkey binding remain
// build-time configuration and are intentionally absent from this screen.
export function SettingsScreen({
  overrides,
  envBundlerUrl,
  envRpcUrl,
  storageAvailable,
  onSave
}: {
  readonly overrides: EndpointOverrides;
  readonly envBundlerUrl?: string;
  readonly envRpcUrl?: string;
  readonly storageAvailable: boolean;
  readonly onSave: (endpoint: "bundler" | "rpc", value: string) => Promise<string | undefined>;
}) {
  return (
    <View style={styles.screen}>
      <Text style={styles.heading}>Settings</Text>
      <Text style={styles.caption}>
        Endpoints are replaceable transports. A value saved here overrides the build-time environment until
        cleared; clearing falls back to the environment value. Invalid URLs are rejected, never silently kept.
      </Text>

      {!storageAvailable && (
        <View style={styles.warnBox}>
          <Text style={styles.warnText}>
            Encrypted device storage is unavailable in this build; endpoint overrides cannot be saved.
          </Text>
        </View>
      )}

      <EndpointField
        label="Bundler URL (any ERC-4337 bundler)"
        placeholder="https://api.pimlico.io/v2/sepolia/rpc?apikey=…"
        initialValue={overrides.bundlerUrl ?? ""}
        fallback={envBundlerUrl}
        disabled={!storageAvailable}
        onSave={value => onSave("bundler", value)}
      />
      <EndpointField
        label="RPC URL (unverified fallback reads)"
        placeholder="https://ethereum-sepolia-rpc.publicnode.com"
        initialValue={overrides.rpcUrl ?? ""}
        fallback={envRpcUrl}
        disabled={!storageAvailable}
        onSave={value => onSave("rpc", value)}
      />
    </View>
  );
}

function EndpointField({
  label,
  placeholder,
  initialValue,
  fallback,
  disabled,
  onSave
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly initialValue: string;
  readonly fallback?: string;
  readonly disabled: boolean;
  readonly onSave: (value: string) => Promise<string | undefined>;
}) {
  const [value, setValue] = React.useState(initialValue);
  const [message, setMessage] = React.useState<string | undefined>();
  const [error, setError] = React.useState(false);

  const save = React.useCallback(async () => {
    const result = await onSave(value);
    if (result) {
      setError(true);
      setMessage(result);
    } else {
      setError(false);
      setMessage(value.trim().length === 0 ? "Cleared — using environment value." : "Saved.");
    }
  }, [onSave, value]);

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        editable={!disabled}
        onChangeText={next => {
          setValue(next);
          setMessage(undefined);
        }}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        style={styles.input}
        value={value}
      />
      {fallback ? <Text style={styles.fallback}>Environment default: {fallback}</Text> : null}
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={() => {
          void save();
        }}
        style={({ pressed }) => [styles.saveButton, pressed && styles.saveButtonPressed, disabled && styles.saveDisabled]}
      >
        <Text style={styles.saveLabel}>Save</Text>
      </Pressable>
      {message ? <Text style={[styles.message, error && styles.messageError]}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { gap: 16 },
  heading: { color: colors.text, fontSize: 24, fontWeight: "700" },
  caption: { color: colors.textDim, fontSize: 13, lineHeight: 19 },
  warnBox: {
    backgroundColor: colors.warnBg,
    borderColor: colors.warnBorder,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12
  },
  warnText: { color: colors.warn, fontSize: 13, lineHeight: 19 },
  field: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderRadius: 16,
    borderWidth: 1,
    gap: 8,
    padding: 16
  },
  fieldLabel: { color: colors.text, fontSize: 14, fontWeight: "600" },
  input: {
    backgroundColor: colors.bg,
    borderColor: colors.cardBorder,
    borderRadius: 10,
    borderWidth: 1,
    color: colors.text,
    fontFamily: "monospace",
    fontSize: 13,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  fallback: { color: colors.textFaint, fontSize: 11, fontFamily: "monospace" },
  saveButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 11
  },
  saveButtonPressed: { backgroundColor: colors.accentPressed },
  saveDisabled: { opacity: 0.4 },
  saveLabel: { color: colors.text, fontSize: 14, fontWeight: "700" },
  message: { color: colors.success, fontSize: 12 },
  messageError: { color: colors.danger }
});
