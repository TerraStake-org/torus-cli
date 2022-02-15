module.exports = {
  env: {
    es2020: true,
    browser: true,
    node: true,
  },
  extends: [
    "airbnb",
    "airbnb-typescript",
    "problems",
    "plugin:@typescript-eslint/recommended",
    "plugin:react/recommended",
    "plugin:react/jsx-runtime",
    "plugin:react-hooks/recommended",
    "standard",
    "eslint:recommended",
    "plugin:prettier/recommended",
    "plugin:import/errors",
    "plugin:import/warnings",
    "plugin:import/typescript",
    "plugin:promise/recommended",
    "plugin:mocha/recommended",
    "prettier",
  ],
  plugins: ["react", "react-hooks", "prettier", "promise", "import", "simple-import-sort", "mocha", "@typescript-eslint", "eslint-plugin-tsdoc"],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 11,
    ecmaFeatures: {
      jsx: true,
    },
  },
  rules: {
    "no-restricted-exports": 0,
    "react/require-default-props": 0,
    "tsdoc/syntax": 1,
    "@typescript-eslint/naming-convention": [
      "error",
      {
        selector: "typeLike",
        format: ["camelCase", "UPPER_CASE", "PascalCase"],
      },
    ],
    "@typescript-eslint/member-ordering": 1,
    "import/prefer-default-export": 0,
    "simple-import-sort/imports": 2,
    "simple-import-sort/exports": 2,
    "no-dupe-class-members": 0,
    "@typescript-eslint/no-dupe-class-members": 2,
    "no-useless-constructor": 0,
    "@typescript-eslint/no-useless-constructor": 2,
    "no-unused-vars": 0,
    "@typescript-eslint/no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "_" }],
    "import/extensions": [
      "error",
      "ignorePackages",
      {
        js: "never",
        ts: "never",
        jsx: "never",
        tsx: "never",
      },
    ],
    "no-console": 2,
    "prettier/prettier": [
      2,
      {
        singleQuote: false,
        printWidth: 150,
        semi: true,
        trailingComma: "es5",
      },
    ],
  },
  settings: {
    "import/resolver": {
      node: {
        extensions: [".js", ".jsx", ".ts", ".tsx", ".json"],
      },
    },
  },
};
