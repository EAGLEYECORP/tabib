import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["supabase/test/**/*.test.ts", "apps/web/**/*.test.ts"],
    // The RLS suite shares one PostgreSQL database and recreates its rows
    // between tests; running files in parallel against it would interleave.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
