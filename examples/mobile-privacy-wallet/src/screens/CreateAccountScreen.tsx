import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { GateList } from "../components/GateList";
import { preparePasskeyAccountCreation } from "../flows/createAccountFlow";
import { createExpoChallengeSource } from "../platform/expoChallengeSource";
import { createNativePasskeyAuthenticator } from "../platform/passkey/nativePasskey";
import type {
  AccountCreationReadiness,
  MobileWalletConfiguration,
  ReleaseGate
} from "../types/wallet";

type ScreenState =
  | { readonly phase: "idle" }
  | { readonly phase: "working" }
  | { readonly phase: "blocked"; readonly gates: readonly ReleaseGate[] }
  | {
      readonly phase: "ready";
      readonly readiness: AccountCreationReadiness;
      readonly gates: readonly ReleaseGate[];
    };

function truncate(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

// Passkey-first onboarding, wired end to end: fresh CSPRNG challenge, native
// platform authenticator, and the createAccountFlow gates rendered as-is. On
// a device without the native module or with incomplete configuration this
// screen shows the blocking gates instead of a simulated success.
export function CreateAccountScreen({ config }: { readonly config: MobileWalletConfiguration }) {
  const [state, setState] = React.useState<ScreenState>({ phase: "idle" });

  const createAccount = React.useCallback(async () => {
    setState({ phase: "working" });
    try {
      const challenge = await createExpoChallengeSource().freshChallenge();
      const result = await preparePasskeyAccountCreation({
        config,
        passkey: createNativePasskeyAuthenticator(),
        userName: "wallet-user",
        displayName: "Wallet User",
        registrationChallenge: challenge
      });
      if (result.status === "blocked") {
        setState({ phase: "blocked", gates: result.gates });
      } else {
        setState({ phase: "ready", readiness: result.value, gates: result.gates ?? [] });
      }
    } catch (error) {
      setState({
        phase: "blocked",
        gates: [
          {
            id: "passkey.runtime.error",
            title: "Account creation failed closed",
            status: "blocked",
            summary: error instanceof Error ? error.message : String(error)
          }
        ]
      });
    }
  }, [config]);

  return (
    <View style={styles.screen}>
      <Text style={styles.heading}>Create account</Text>
      <Text style={styles.body}>
        Creates a platform passkey with a fresh 32-byte challenge and prepares a
        Loom account bound to it. No seed phrase, no hosted signer, no fallback.
      </Text>

      <Pressable
        accessibilityRole="button"
        disabled={state.phase === "working"}
        onPress={() => {
          void createAccount();
        }}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      >
        <Text style={styles.buttonLabel}>
          {state.phase === "working" ? "Waiting for platform passkey…" : "Create passkey account"}
        </Text>
      </Pressable>

      {state.phase === "blocked" && <GateList gates={state.gates} />}

      {state.phase === "ready" && (
        <View style={styles.result}>
          <Text style={styles.resultTitle}>Passkey registered</Text>
          <Text style={styles.resultLine}>
            credentialIdHash {truncate(state.readiness.registration.credentialIdHash)}
          </Text>
          <Text style={styles.resultLine}>
            publicKeyX {truncate(state.readiness.registration.publicKeyX)}
          </Text>
          <Text style={styles.resultLine}>rpId {state.readiness.registration.rpId}</Text>
          <Text style={styles.recoveryWarning}>
            Recovery status: {state.readiness.recoveryStatus}. This account has no
            guardians yet; set up recovery before funding it.
          </Text>
          <GateList gates={state.gates} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    gap: 14
  },
  heading: {
    color: "#f7f9fc",
    fontSize: 24,
    fontWeight: "700"
  },
  body: {
    color: "#bac6d6",
    fontSize: 15,
    lineHeight: 22
  },
  button: {
    alignItems: "center",
    backgroundColor: "#2451e6",
    borderRadius: 14,
    paddingVertical: 14
  },
  buttonPressed: {
    backgroundColor: "#1d43be"
  },
  buttonLabel: {
    color: "#f7f9fc",
    fontSize: 16,
    fontWeight: "700"
  },
  result: {
    backgroundColor: "#0f1a12",
    borderColor: "#234a2e",
    borderRadius: 14,
    borderWidth: 1,
    gap: 8,
    padding: 14
  },
  resultTitle: {
    color: "#bff0c8",
    fontSize: 16,
    fontWeight: "700"
  },
  resultLine: {
    color: "#9fd4ab",
    fontFamily: "monospace",
    fontSize: 12
  },
  recoveryWarning: {
    color: "#ffd9c2",
    fontSize: 13,
    lineHeight: 19
  }
});
