import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    base: "/",
    plugins: [react()],
    resolve: {
        // Keep a single survey-core instance or its Serializer singleton breaks.
        // Load-bearing in dev:local/build:local: the aliased sibling builds sit
        // next to their own React 17 copy, which would otherwise get pulled in too.
        dedupe: ["survey-core", "react", "react-dom"]
    },
    server: {
        port: 5177,
        proxy: {
            "/api": "http://localhost:8080",
            "/ws": { target: "ws://localhost:8080", ws: true }
        }
    }
});
