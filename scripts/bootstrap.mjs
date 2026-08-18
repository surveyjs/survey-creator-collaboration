// Makes a bare checkout runnable with `npm install && npm start`.
//
// This app needs ten survey packages that are NOT usable from the npm registry:
// the published survey-creator-core does not contain CollaborationPlugin, it
// exists only on the survey-creator `feature/journal-plugin` branch. And the
// `file:` deps of lobby/ + clients/* point at sibling `build/` output dirs, which
// are gitignored in both sibling repos — so a fresh checkout has nothing to link.
//
// Runs as `postinstall`. Idempotent: every step is skipped when its output is
// already in place, so a second `npm install` costs seconds.
//
//   COLLAB_SKIP_BOOTSTRAP=1   do nothing (CI, `npm install <pkg>`)
//   COLLAB_FORCE_REBUILD=1    ignore all skips, rebuild everything
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PARENT = path.dirname(ROOT);

const MIN_NODE = [20, 11]; // Angular 18 needs ^18.19 || ^20.11 || >=22; we require 20.11+
const FORCE = !!process.env.COLLAB_FORCE_REBUILD;

const SIBLINGS = [
    { dir: "survey-library", url: "https://github.com/surveyjs/survey-library", branch: "V3" },
    { dir: "survey-creator", url: "https://github.com/surveyjs/survey-creator", branch: "feature/journal-plugin" }
];

// Strict order: each package is a Junction symlink to the previous one's build/ output,
// so an upstream package must be built before a downstream one can build.
// survey-core -> survey-*-ui -> survey-creator-core -> survey-creator-*
const PACKAGES = [
    { repo: "survey-library", name: "survey-core", script: "build:all" },
    { repo: "survey-library", name: "survey-react-ui", script: "build" },
    { repo: "survey-library", name: "survey-vue3-ui", script: "build" },
    { repo: "survey-library", name: "survey-js-ui", script: "build" },
    { repo: "survey-library", name: "survey-angular-ui", script: "build" },
    { repo: "survey-creator", name: "survey-creator-core", script: "build:all" },
    { repo: "survey-creator", name: "survey-creator-react", script: "build" },
    { repo: "survey-creator", name: "survey-creator-vue", script: "build" },
    { repo: "survey-creator", name: "survey-creator-js", script: "build" },
    { repo: "survey-creator", name: "survey-creator-angular", script: "build" }
];

const CLIENTS = ["lobby", "clients/react", "clients/vue", "clients/js", "clients/angular"];

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

let step = 0;
let steps = 0;
const started = Date.now();

function log(message) {
    console.log(message);
}

function elapsed(from) {
    const s = Math.round((Date.now() - from) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function fail(message, hint) {
    console.error(`\nbootstrap: ${message}`);
    if (hint) console.error(hint);
    process.exit(1);
}

// Nested npm calls must not inherit the parent npm's npm_config_* / npm_package_* /
// INIT_CWD: npm_config_local_prefix in particular makes a child install resolve
// against THIS package instead of its own cwd.
function childEnv(extra) {
    const keep = new Set([
        "npm_config_registry", "npm_config_cache", "npm_config_userconfig", "npm_config_globalconfig",
        "npm_config_proxy", "npm_config_https_proxy", "npm_config_noproxy", "npm_config_strict_ssl"
    ]);
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (key.toLowerCase().startsWith("npm_") && !keep.has(key.toLowerCase())) continue;
        if (key === "INIT_CWD") continue;
        env[key] = value;
    }
    // Re-entrancy guard: nothing we spawn should trigger this script again.
    env.COLLAB_SKIP_BOOTSTRAP = "1";
    return Object.assign(env, extra);
}

// Windows needs a shell — spawning npm.cmd without one throws EINVAL since
// Node 18.20/20.12 (CVE-2024-27980) — and the command has to be one string,
// because passing an args array together with shell:true is deprecated (DEP0190).
// Every argument below is a literal constant, so concatenation is safe here.
function spawnAt(command, args, cwd, options) {
    return process.platform === "win32"
        ? spawnSync([command, ...args].join(" "), { cwd, shell: true, ...options })
        : spawnSync(command, args, { cwd, ...options });
}

function run(command, args, cwd) {
    const result = spawnAt(command, args, cwd, { stdio: "inherit", env: childEnv() });
    if (result.error) fail(`cannot run \`${command}\`: ${result.error.message}`);
    if (result.status !== 0) {
        fail(
            `\`${command} ${args.join(" ")}\` failed (exit ${result.status})\n  in ${cwd}`,
            "  Fix the cause above, then re-run `npm run bootstrap` (already-built packages are skipped)."
        );
    }
}

function capture(command, args, cwd) {
    const result = spawnAt(command, args, cwd, { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}

function npmInstall(cwd, label, extraArgs = []) {
    step += 1;
    const at = Date.now();
    log(`\n[${step}/${steps}] install ${label}`);
    run(NPM, ["install", "--no-audit", "--no-fund", ...extraArgs], cwd);
    log(`[${step}/${steps}] install ${label} — done in ${elapsed(at)}`);
}

function skip(label, reason) {
    step += 1;
    log(`[${step}/${steps}] ${label} — skip (${reason})`);
}

function checkNode() {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
        fail(
            `Node ${MIN_NODE.join(".")}+ required, running ${process.versions.node}`,
            "  The Angular 18 client will not build on older Node."
        );
    }
}

function ensureSiblings() {
    for (const sibling of SIBLINGS) {
        const dir = path.join(PARENT, sibling.dir);
        if (!fs.existsSync(dir)) {
            if (!capture("git", ["--version"], PARENT)) {
                fail(
                    `\`git\` not found in PATH, cannot clone ${sibling.dir}`,
                    `  Install git, or clone manually into ${dir}:\n` +
                    `    git clone --branch ${sibling.branch} ${sibling.url}`
                );
            }
            const at = Date.now();
            log(`\ncloning ${sibling.dir} (${sibling.branch}) into ${dir}`);
            // core.longpaths: both repos contain paths over the Windows 260-char limit
            // (survey-library's screenshot snapshots), which makes checkout fail.
            const clone = spawnAt(
                "git",
                ["-c", "core.longpaths=true", "clone", "--branch", sibling.branch, "--depth", "1", sibling.url, sibling.dir],
                PARENT,
                { stdio: "inherit", env: childEnv() }
            );
            if (clone.status !== 0) {
                // A half-cloned dir would be mistaken for a usable checkout next run.
                fs.rmSync(dir, { recursive: true, force: true });
                fail(
                    `failed to clone ${sibling.url} (${sibling.branch})`,
                    "  Check the output above (network? disk? path length?), then re-run `npm run bootstrap`.\n" +
                    `  You can also clone it yourself into ${dir}.`
                );
            }
            log(`cloned ${sibling.dir} in ${elapsed(at)}`);
            continue;
        }
        if (!fs.existsSync(path.join(dir, "packages"))) {
            fail(
                `${dir} exists but has no packages/ dir — that is not a ${sibling.dir} checkout`,
                `  Remove it and re-run \`npm run bootstrap\` to clone ${sibling.url} (${sibling.branch}).`
            );
        }
        const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"], dir);
        if (branch && branch !== sibling.branch) {
            log(`note: ${sibling.dir} is on branch \`${branch}\`, expected \`${sibling.branch}\` — using it as is`);
        } else {
            log(`found ${sibling.dir} (${branch ?? "no git metadata"})`);
        }
    }
}

// The clients import CollaborationPlugin from survey-creator-core (see
// shared/collab-client.ts). A survey-creator checkout without it builds fine
// and then fails at bundle time with a confusing "no exported member" error.
// The whole feature lives under plugins/collaboration - the journal, presence
// and the strip are its subfolders, not separate plugins.
function checkPlugins() {
    const pluginsDir = path.join(PARENT, "survey-creator", "packages", "survey-creator-core", "src", "plugins", "collaboration");
    const missing = ["journal", "presence", "bar"].filter((name) => !fs.existsSync(path.join(pluginsDir, name)));
    if (missing.length > 0) {
        fail(
            `survey-creator is missing the ${missing.join(", ")} plugin source (${pluginsDir})`,
            "  Collaboration needs the `feature/journal-plugin` branch:\n" +
            `    git -C ${path.join(PARENT, "survey-creator")} checkout feature/journal-plugin\n` +
            "  Then re-run `npm run bootstrap`."
        );
    }
}

function packagePaths(pkg) {
    const dir = path.join(PARENT, pkg.repo, "packages", pkg.name);
    return { dir, source: path.join(dir, "package.json"), built: path.join(dir, "build", "package.json") };
}

// A package is considered built when its build/ manifest exists at the same
// version as its source manifest — that also catches a stale build left over
// from an older version of the sibling repo.
function isBuilt(pkg) {
    const { source, built } = packagePaths(pkg);
    const sourceJson = readJson(source);
    const builtJson = readJson(built);
    if (!sourceJson) return false;
    return !!builtJson && builtJson.version === sourceJson.version;
}

// Local survey deps (`"survey-core": "../../survey-library/packages/survey-core/build"`)
// are installed as symlinks into the sibling build/ dirs. If a sibling repo was moved,
// removed or not yet built, node_modules looks complete while those links dangle — and
// the client build then fails with a cryptic module-resolution error. Treat that as
// "not installed" so the client is installed again once the builds are in place.
function isInstalled(dir) {
    if (!fs.existsSync(path.join(dir, "node_modules", ".package-lock.json"))) return false;
    const manifest = readJson(path.join(dir, "package.json"));
    const deps = { ...manifest?.dependencies, ...manifest?.devDependencies };
    return Object.entries(deps)
        .filter(([, version]) => /^(file:|\.\.[\\/])/.test(String(version)))
        .every(([name]) => !!readJson(path.join(dir, "node_modules", name, "package.json")));
}

function main() {
    if (process.env.COLLAB_SKIP_BOOTSTRAP) {
        log("bootstrap: skipped (COLLAB_SKIP_BOOTSTRAP is set)");
        return;
    }

    checkNode();

    log("bootstrap: preparing sibling survey repos and local builds");
    ensureSiblings();
    checkPlugins();

    const todoPackages = PACKAGES.filter((pkg) => FORCE || !isBuilt(pkg));
    const repos = [...new Set(todoPackages.map((pkg) => pkg.repo))];
    const reposToInstall = repos.filter((repo) => FORCE || !isInstalled(path.join(PARENT, repo)));
    const clientsToInstall = CLIENTS.filter((client) => FORCE || !isInstalled(path.join(ROOT, client)));

    if (todoPackages.length === 0 && clientsToInstall.length === 0) {
        log("bootstrap: everything is already in place — nothing to do");
        return;
    }

    steps = reposToInstall.length + PACKAGES.length + CLIENTS.length;
    if (todoPackages.length > 0) {
        log(
            `\nbuilding ${todoPackages.length} survey package(s): ${todoPackages.map((pkg) => pkg.name).join(", ")}` +
            "\nthe first run takes ~20-40 minutes and a few GB of disk (Angular and Vue are the slow ones)"
        );
    }

    // Sibling repo roots: package build configs import shared root files
    // (e.g. survey-library/rollup.helpers.mjs), so the root install is required.
    // --ignore-scripts is mandatory here: both roots have
    // "postinstall": "playwright install chromium" and "prepare": "husky install".
    for (const repo of repos) {
        if (reposToInstall.includes(repo)) {
            npmInstall(path.join(PARENT, repo), `${repo} (root)`, ["--ignore-scripts"]);
        }
    }

    for (const pkg of PACKAGES) {
        if (!todoPackages.includes(pkg)) {
            skip(`build ${pkg.name}`, "build/ is up to date");
            continue;
        }
        const { dir } = packagePaths(pkg);
        const at = Date.now();
        step += 1;
        log(`\n[${step}/${steps}] build ${pkg.name} (${pkg.repo})`);
        // No --ignore-scripts inside packages: their deps (esbuild &c.) need install scripts.
        run(NPM, ["install", "--no-audit", "--no-fund"], dir);
        run(NPM, ["run", pkg.script], dir);
        if (!isBuilt(pkg)) {
            fail(
                `${pkg.name} reported success but produced no build/package.json at its source version`,
                `  Check ${path.join(dir, "build")}.`
            );
        }
        log(`[${step}/${steps}] build ${pkg.name} — done in ${elapsed(at)}`);
    }

    for (const client of CLIENTS) {
        if (!clientsToInstall.includes(client)) {
            skip(`install ${client}`, "node_modules present");
            continue;
        }
        npmInstall(path.join(ROOT, client), client);
    }

    log(`\nbootstrap: done in ${elapsed(started)} — run \`npm start\` and open http://localhost:8080`);
}

main();
