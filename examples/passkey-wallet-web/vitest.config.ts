import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/components/**/*.test.tsx"],
    restoreMocks: true
  }
});
