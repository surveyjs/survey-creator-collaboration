/// <reference types="vite/client" />
import { createApp, h } from "vue";
import { slk } from "survey-core";
import { SurveyCreatorModel, registerCreatorTheme } from "survey-creator-core";
// Collaboration ships as its own bundle - the default creator carries
// neither its JS nor its CSS.
import { CollaborationPlugin } from "survey-creator-core/collaboration";
import SurveyThemes from "survey-core/themes";
import { SurveyCreatorComponent } from "survey-creator-vue";
import { connectCollab, getDisplayName, getRoomIdFromUrl } from "../../../shared/collab-client";
import "survey-core/survey-core.css";
import "survey-creator-core/survey-creator-core.css";
import "survey-creator-core/collaboration.css";
// Localization dictionaries: importing registers all bundled locales (ru, de,
// fr, ...) — without them the Translation tab has no languages to add.
import "survey-core/i18n";
import "survey-creator-core/i18n";

// Baked in at build time from the environment (see envPrefix in vite.config.ts).
if (import.meta.env.SURVEYJS_LICENSE_KEY) slk(import.meta.env.SURVEYJS_LICENSE_KEY);

// Only the light creator theme is registered out of the box; without a dark
// variant of each theme the Light/Dark switch in the creator's theme settings
// stays disabled. registerCreatorTheme expects survey-core themes (themeName +
// colorPalette pairs), not the survey-creator-core/themes bundle.
registerCreatorTheme(SurveyThemes);

const roomId = getRoomIdFromUrl();
if (!roomId) {
    location.href = "/";
} else {
    const creator = new SurveyCreatorModel({
        showLogicTab: true,
        showTranslationTab: true,
        showJSONEditorTab: true
    });

    // One plugin: the change journal, presence capture/rendering and the
    // collaboration strip above the tabs. Host-specific bits - the lobby
    // invite link and navigation - are options.
    const collab = new CollaborationPlugin(creator, {
        roomId,
        framework: "Vue 3",
        getInviteLink: () => `${location.origin}/?room=${encodeURIComponent(roomId)}`,
        onBack: () => { location.href = "/"; }
    });
    creator.addPlugin("collaboration", collab);

    connectCollab({
        creator, collab, roomId,
        name: getDisplayName(),
        onStatus: (s) => collab.setStatus(s),
        onHistoryChanged: (changes) => collab.setHistory(changes)
    });

    createApp({ render: () => h(SurveyCreatorComponent, { model: creator }) }).mount("#root");
}
