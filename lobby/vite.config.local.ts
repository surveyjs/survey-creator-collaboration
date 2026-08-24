// `npm run dev:local` / `npm run build:local`: take the survey-* packages from the
// sibling ../survey-library and ../survey-creator build/ dirs instead of the npm
// copies, for working on the collaboration plugin itself. See
// scripts/local-survey-alias.mjs for why the aliases are derived from `exports`.
//
// Deliberately outside tsconfig "include" - it would drag @types/node into an app
// that has no other use for it. `npm run typecheck:local` covers the same setup.
import { defineConfig, loadEnv, mergeConfig } from "vite";
import base from "./vite.config";
import { localSurveyAlias } from "../scripts/local-survey-alias.mjs";

export default defineConfig(({ mode }) =>
    mergeConfig(base, {
        // SURVEYJS_LIBV3 (repo-root .env, same as SURVEYJS_LICENSE_KEY) relocates the
        // sibling checkouts; without it they are expected next to this repo.
        resolve: { alias: localSurveyAlias(loadEnv(mode, "..", "SURVEYJS_")) }
    })
);
