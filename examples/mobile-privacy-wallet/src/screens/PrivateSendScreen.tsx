import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { GateList } from "../components/GateList";
import { preparePrivateSend, type PrivateSendReadiness } from "../flows/privacySendFlow";
import type { MobileWalletConfiguration, ReleaseGate } from "../types/wallet";

type ScreenState =
  | { readonly phase: "idle" }
  | { readonly phase: "working" }
  | { readonly phase: "blocked"; readonly gates: readonly ReleaseGate[] }
  | { readonly phase: "ready"; readonly readiness: PrivateSendReadiness };

// Private send, wired to the real flow. In this boilerplate the flow is
// expected to come back blocked (no Railgun evidence, no privacy context) —
// and that is the point: the screen demonstrates how a fork must surface the
// gates and, once a profile passes, how the metadata budget is shown to the
// user before any private operation is built.
export function PrivateSendScreen({ config }: { readonly config: MobileWalletConfiguration }) {
  const [state, setState] = React.useState<ScreenState>({ phase: "idle" });

  const checkReadiness = React.useCallback(async () => {
    setState({ phase: "working" });
    const result = await preparePrivateSend({
      config,
      draft: {
        asset: "0x0000000000000000000000000000000000000000",
        amount: 0n,
        recipient: "",
        maxFee: 0n,
        deadline: 0n
      }
    });
    if (result.status === "blocked") {
      setState({ phase: "blocked", gates: result.gates });
    } else {
      setState({ phase: "ready", readiness: result.value });
    }
  }, [config]);

  return (
    <View style={styles.screen}>
      <Text style={styles.heading}>Private send</Text>
      <Text style={styles.body}>
        Railgun private transfer stays disabled until adapter evidence passes.
        When it is enabled, the metadata budget below is what a transfer still
        reveals — the user must see it before an operation is built.
      </Text>

      <Pressable
        accessibilityRole="button"
        disabled={state.phase === "working"}
        onPress={() => {
          void checkReadiness();
        }}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      >
        <Text style={styles.buttonLabel}>
          {state.phase === "working" ? "Checking readiness…" : "Check private send readiness"}
        </Text>
      </Pressable>

      {state.phase === "blocked" && <GateList gates={state.gates} />}

      {state.phase === "ready" && (
        <View style={styles.budget}>
          <Text style={styles.budgetTitle}>
            Metadata budget — {state.readiness.metadataBudget.protocol}
          </Text>
          {state.readiness.metadataBudget.items.map(item => (
            <View key={item.surface} style={styles.budgetItem}>
              <Text style={styles.budgetSurface}>
                {item.surface}
                {item.required ? " (required)" : ""}
              </Text>
              <Text style={styles.budgetReveals}>{item.reveals}</Text>
            </View>
          ))}
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
    backgroundColor: "#3a2a63",
    borderRadius: 14,
    paddingVertical: 14
  },
  buttonPressed: {
    backgroundColor: "#2e2150"
  },
  buttonLabel: {
    color: "#f7f9fc",
    fontSize: 16,
    fontWeight: "700"
  },
  budget: {
    backgroundColor: "#151022",
    borderColor: "#392a5e",
    borderRadius: 14,
    borderWidth: 1,
    gap: 10,
    padding: 14
  },
  budgetTitle: {
    color: "#d3c2ff",
    fontSize: 16,
    fontWeight: "700"
  },
  budgetItem: {
    gap: 2
  },
  budgetSurface: {
    color: "#b49dff",
    fontFamily: "monospace",
    fontSize: 13
  },
  budgetReveals: {
    color: "#c8bce6",
    fontSize: 13,
    lineHeight: 19
  }
});
