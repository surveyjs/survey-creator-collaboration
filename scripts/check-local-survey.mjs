// Pre-hook for the Angular client's `:local` scripts.
//
// The vite apps get this for free: their vite.config.local.ts calls localSurveyAlias()
// while loading the config, so a missing or version-skewed set of sibling builds stops
// the run right there. Angular resolves through static tsconfig paths instead, so
// nothing would notice until survey-core complains in the browser console.
import { localSurveyAlias } from "./local-survey-alias.mjs";

try {
    localSurveyAlias();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
