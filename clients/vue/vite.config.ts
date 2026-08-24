import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
    base: "/vue/",
    plugins: [vue()],
    // Expose SURVEYJS_* env vars (e.g. SURVEYJS_LICENSE_KEY from docker compose)
    // to the bundle via import.meta.env at BUILD time.
    envPrefix: ["VITE_", "SURVEYJS_"],
    // Single shared .env at the repo root serves all clients.
    envDir: "../..",
    resolve: {
        // Keep a single survey-core instance or its Serializer singleton breaks.
        // Load-bearing in dev:local/build:local: the aliased sibling builds sit
        // next to their own Vue 3.4 copy, which would otherwise get pulled in too.
        dedupe: ["survey-core", "survey-creator-core", "vue"]
    },
    server: {
        port: 5175,
        // Allow importing ../../shared/*.ts sources in dev mode.
        fs: { allow: ["../.."] },
        proxy: {
            "/api": "http://localhost:8080",
            "/ws": { target: "ws://localhost:8080", ws: true }
        }
    }
});
