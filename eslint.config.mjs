import globals from "globals";

export default [
    {
        ignores: [
            "**/node_modules/**",
            "**/.vscode-test/**",
            "**/.git/**",
        ],
    },
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: {
                ...globals.commonjs,
                ...globals.node,
                ...globals.mocha,
            },
        },
        rules: {
            "no-const-assign": "warn",
            "no-this-before-super": "warn",
            "no-undef": "warn",
            "no-unreachable": "warn",
            "no-unused-vars": "warn",
            "constructor-super": "warn",
            "valid-typeof": "warn",
        },
    },
    {
        // The webview GUI runs in a browser-like sandbox.
        files: ["media/**/*.js"],
        languageOptions: {
            sourceType: "script",
            globals: {
                ...globals.browser,
                acquireVsCodeApi: "readonly",
            },
        },
    },
];
