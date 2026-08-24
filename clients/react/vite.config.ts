import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    base: "/react/",
    plugins: [react()],
    // Expose SURVEYJS_* env vars (e.g. SURVEYJS_LICENSE_KEY from docker compose)
    // to the bundle via import.meta.env at BUILD time.
    envPrefix: ["VITE_", "SURVEYJS_"],
    // Single shared .env at the repo root serves all clients.
    envDir: "../..",
    resolve: {
        // Keep a single survey-core instance or its Serializer singleton breaks.
        // Load-bearing in dev:local/build:local: the aliased sibling builds sit
        // next to their own React 17 copy, which would otherwise get pulled in too.
        dedupe: ["survey-core", "survey-creator-core", "react", "react-dom"]
    },
    server: {
        port: 5174,
        // Allow importing ../../shared/*.ts sources in dev mode.
        fs: { allow: ["../.."] },
        proxy: {
            "/api": "http://localhost:8080",
            "/ws": { target: "ws://localhost:8080", ws: true }
        }
    }
});
