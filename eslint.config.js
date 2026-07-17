import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["public/pcm-worklet.js"],
    languageOptions: {
      globals: { AudioWorkletProcessor: "readonly", registerProcessor: "readonly" },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        crypto: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        AudioWorkletProcessor: "readonly",
        registerProcessor: "readonly",
      },
    },
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
