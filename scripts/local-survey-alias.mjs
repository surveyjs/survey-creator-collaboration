// Vite `resolve.alias` entries that point the survey-* packages at the sibling
// build/ dirs (../survey-library, ../survey-creator) instead of the npm copies.
// Used only by the vite.config.local.ts of each app — see `npm run dev:*:local`.
//
// Why the aliases are DERIVED from each package's `exports` map instead of being
// a plain "survey-core" -> "<dir>" string:
//
//   A string alias is substituted before resolution, so it bypasses `exports`.
//   Bare names would still work (vite reads `module` from the dir's package.json),
//   but subpaths have no package.json of their own and land on the CJS bundles —
//   survey-core/themes on themes/index.js, survey-creator-core/collaboration on
//   collaboration.js. Those UMD files `require("survey-core")`, which resolves to
//   the CJS entry, so the bundle ends up with a SECOND copy of the library (+2.7MB,
//   two Serializer singletons). In dev it is worse: vite serves the untransformed
//   UMD, the page loads, and the import is `undefined` at runtime.
//
// Reading `exports` aims every specifier straight at the same fesm/*.mjs the npm
// resolution would pick, which keeps local mode at parity with npm mode and covers
// CSS and i18n subpaths without a hand-kept table.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** <repo>/scripts/ -> <repo> */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SIBLINGS = {
    "survey-core": "survey-library/packages/survey-core",
    "survey-react-ui": "survey-library/packages/survey-react-ui",
    "survey-vue3-ui": "survey-library/packages/survey-vue3-ui",
    "survey-js-ui": "survey-library/packages/survey-js-ui",
    "survey-angular-ui": "survey-library/packages/survey-angular-ui",
    "survey-creator-core": "survey-creator/packages/survey-creator-core",
    "survey-creator-react": "survey-creator/packages/survey-creator-react",
    "survey-creator-vue": "survey-creator/packages/survey-creator-vue",
    "survey-creator-js": "survey-creator/packages/survey-creator-js",
    "survey-creator-angular": "survey-creator/packages/survey-creator-angular"
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pick = (target) =>
    typeof target === "string" ? target : target?.import ?? target?.default ?? target?.require ?? null;

/**
 * Where the sibling checkouts live. Defaults to the folder holding this repo;
 * SURVEYJS_LIBV3 overrides it (absolute, or relative to the repo root) — same
 * variable and meaning as in the theme-adapter-demos repo.
 */
function siblingsBase(env) {
    const override = env?.SURVEYJS_LIBV3 ?? process.env.SURVEYJS_LIBV3;
    return override ? path.resolve(ROOT, override) : path.dirname(ROOT);
}

function aliasesFor(pkgDir) {
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const map = manifest.exports ?? { ".": manifest.module ?? manifest.main };
    const out = [];
    for (const [key, target] of Object.entries(map)) {
        const file = pick(target);
        if (!file) continue;
        const spec = manifest.name + key.slice(1);
        const abs = path.resolve(pkgDir, file).replace(/\\/g, "/");
        if (spec.includes("*")) {
            const [specPrefix, specSuffix] = spec.split("*");
            const [filePrefix, fileSuffix] = abs.split("*");
            out.push({
                find: new RegExp("^" + escapeRe(specPrefix) + "(.+)" + escapeRe(specSuffix) + "$"),
                replacement: filePrefix + "$1" + fileSuffix,
                weight: specPrefix.length
            });
        } else {
            out.push({ find: new RegExp("^" + escapeRe(spec) + "$"), replacement: abs, weight: spec.length + 1000 });
        }
    }
    return { version: manifest.version, aliases: out };
}

/**
 * @param {Record<string, string>} [env] result of vite's loadEnv(), so SURVEYJS_LIBV3
 *   can live in the repo-root .env next to SURVEYJS_LICENSE_KEY
 * @returns {Array<{find: RegExp, replacement: string}>}
 */
export function localSurveyAlias(env) {
    const base = siblingsBase(env);
    const aliases = [];
    const versions = new Map();
    const missing = [];

    for (const [name, rel] of Object.entries(SIBLINGS)) {
        const dir = path.join(base, rel, "build");
        if (!fs.existsSync(path.join(dir, "package.json"))) {
            missing.push({ name, dir });
            continue;
        }
        const built = aliasesFor(dir);
        aliases.push(...built.aliases);
        versions.set(name, built.version);
    }

    // A partially local set is a breakage, not a fallback: mixing local and npm
    // copies of the same library is exactly what silently doubles survey-core.
    if (missing.length > 0) {
        throw new Error(
            "local-survey-alias: no local build for " + missing.map((m) => m.name).join(", ") + ".\n" +
            "  Expected under " + base + " (override with SURVEYJS_LIBV3). Missing:\n" +
            missing.map((m) => "    " + m.dir).join("\n") + "\n" +
            "  Build them in ../survey-library and ../survey-creator, point SURVEYJS_LIBV3 at\n" +
            "  the right folder, or use the plain npm scripts (`npm run dev:react`) instead."
        );
    }

    // survey-core refuses to work with a differently-versioned sibling: it prints
    // "SurveyJS libraries should have the same versions" from the browser, which
    // reads like a real error. Say it here, where it is actionable, instead.
    const distinct = [...new Set(versions.values())];
    if (distinct.length > 1) {
        const byVersion = distinct
            .map((v) => "    " + v + ": " + [...versions].filter(([, x]) => x === v).map(([n]) => n).join(", "))
            .join("\n");
        throw new Error(
            "local-survey-alias: the local builds are at different versions.\n" + byVersion + "\n" +
            "  survey-core rejects a mismatched set at runtime. Rebuild the sibling checkouts\n" +
            "  from the same release before using the :local scripts."
        );
    }

    // vite matches alias entries in array order, so put the most specific first.
    return aliases.sort((a, b) => b.weight - a.weight).map(({ find, replacement }) => ({ find, replacement }));
}
