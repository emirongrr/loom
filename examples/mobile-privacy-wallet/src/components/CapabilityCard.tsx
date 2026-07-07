import React from "react";
import { StyleSheet, Text, View } from "react-native";

interface CapabilityCardProps {
  readonly title: string;
  readonly status: string;
  readonly body: string;
}

export function CapabilityCard({ title, status, body }: CapabilityCardProps) {
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.badge}>{status}</Text>
      </View>
      <Text style={styles.body}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#111722",
    borderColor: "#243044",
    borderRadius: 18,
    borderWidth: 1,
    gap: 10,
    padding: 16
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between"
  },
  title: {
    color: "#f7f9fc",
    fontSize: 18,
    fontWeight: "700"
  },
  badge: {
    backgroundColor: "#1c2d42",
    borderRadius: 999,
    color: "#9fc7ff",
    fontSize: 12,
    overflow: "hidden",
    paddingHorizontal: 10,
    paddingVertical: 5
  },
  body: {
    color: "#bac6d6",
    fontSize: 14,
    lineHeight: 21
  }
});

