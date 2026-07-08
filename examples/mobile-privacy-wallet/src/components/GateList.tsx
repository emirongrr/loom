import React from "react";
import { StyleSheet, Text, View } from "react-native";

import type { ReleaseGate } from "../types/wallet";

// Renders blocked/not-configured gates exactly as the flows report them. The
// UI never softens or hides a gate: a blocked path is shown as blocked, with
// the reason, so a fork cannot ship a flow that silently looks enabled.
export function GateList({ gates }: { readonly gates: readonly ReleaseGate[] }) {
  if (gates.length === 0) {
    return null;
  }
  return (
    <View style={styles.list}>
      {gates.map(gate => (
        <View key={gate.id} style={styles.gate}>
          <View style={styles.row}>
            <Text style={styles.title}>{gate.title}</Text>
            <Text style={styles.badge}>{gate.status}</Text>
          </View>
          <Text style={styles.summary}>{gate.summary}</Text>
          <Text style={styles.id}>{gate.id}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: 10
  },
  gate: {
    backgroundColor: "#1a1210",
    borderColor: "#4a2e22",
    borderRadius: 14,
    borderWidth: 1,
    gap: 6,
    padding: 14
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between"
  },
  title: {
    color: "#ffd9c2",
    flexShrink: 1,
    fontSize: 15,
    fontWeight: "700"
  },
  badge: {
    backgroundColor: "#40231a",
    borderRadius: 999,
    color: "#ffb38a",
    fontSize: 11,
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 4
  },
  summary: {
    color: "#e3c7b8",
    fontSize: 13,
    lineHeight: 19
  },
  id: {
    color: "#8a6d5f",
    fontFamily: "monospace",
    fontSize: 11
  }
});
