import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "desktop/dist/**",
    "desktop/public/rill-pdf-engine/**",
    "src-tauri/target/**",
    "next-env.d.ts",
  ]),
  {
    files: ["desktop/src/App.tsx"],
    rules: {
      // The desktop shell deliberately mirrors persisted/native state into React effects.
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
