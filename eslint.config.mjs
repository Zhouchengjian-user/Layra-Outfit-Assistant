import { defineConfig, globalIgnores } from "eslint/config";
import eslint from "@eslint/js";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  globalIgnores([
    ".next/**",
    "dist/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "scripts/**",
  ]),
  eslint.configs.recommended,
  nextVitals,
  nextTs,
]);

export default eslintConfig;
