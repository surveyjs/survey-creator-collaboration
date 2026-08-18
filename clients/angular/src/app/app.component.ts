import { AfterViewInit, Component, OnDestroy } from "@angular/core";
// Localization dictionaries: importing registers all bundled locales (ru, de,
// fr, ...) — without them the Translation tab has no languages to add.
import "survey-core/i18n";
import "survey-creator-core/i18n";
import { slk } from "survey-core";
import { SurveyCreatorModel, registerCreatorTheme } from "survey-creator-core";
// Collaboration ships as its own bundle - the default creator carries
// neither its JS nor its CSS.
import { CollaborationPlugin } from "survey-creator-core/collaboration";
import SurveyThemes from "survey-core/themes";
import { SurveyCreatorModule } from "survey-creator-angular";
import { connectCollab, getDisplayName, getRoomIdFromUrl } from "../../../../shared/collab-client";
import type { ICollabConnection } from "../../../../shared/collab-client";
import { SURVEYJS_LICENSE_KEY } from "../license-key";

// Baked in at build time from the environment (see scripts/gen-license-key.mjs).
if (SURVEYJS_LICENSE_KEY) slk(SURVEYJS_LICENSE_KEY);

// Only the light creator theme is registered out of the box; without a dark
// variant of each theme the Light/Dark switch in the creator's theme settings
// stays disabled. registerCreatorTheme expects survey-core themes (themeName +
// colorPalette pairs), not the survey-creator-core/themes bundle.
registerCreatorTheme(SurveyThemes);

@Component({
    selector: "app-root",
    standalone: true,
    imports: [SurveyCreatorModule],
    template: `
        <div style="flex: 1; position: relative">
            <survey-creator [model]="creator"></survey-creator>
        </div>
    `
})
export class AppComponent implements AfterViewInit, OnDestroy {
    public readonly creator: SurveyCreatorModel;
    private readonly collab: CollaborationPlugin;
    private readonly roomId: string | null;
    private connection?: ICollabConnection;

    constructor() {
        this.roomId = getRoomIdFromUrl();
        if (!this.roomId) location.href = "/";

        this.creator = new SurveyCreatorModel({
            showLogicTab: true,
            showTranslationTab: true,
            showJSONEditorTab: true
        });
        // One plugin: the change journal, presence capture/rendering and the
        // collaboration strip above the tabs. Host-specific bits — the lobby
        // invite link and navigation — are options.
        const roomId = this.roomId ?? "";
        this.collab = new CollaborationPlugin(this.creator, {
            roomId,
            framework: "Angular",
            getInviteLink: () => `${location.origin}/?room=${encodeURIComponent(roomId)}`,
            onBack: () => { location.href = "/"; }
        });
        this.creator.addPlugin("collaboration", this.collab);
    }

    ngAfterViewInit(): void {
        if (!this.roomId) return;
        this.connection = connectCollab({
            creator: this.creator,
            collab: this.collab,
            roomId: this.roomId,
            name: getDisplayName(),
            onStatus: (s) => this.collab.setStatus(s),
            onHistoryChanged: (changes) => this.collab.setHistory(changes)
        });
    }

    ngOnDestroy(): void {
        // One dispose now covers the journal too - it used to outlive the
        // component, keeping its creator.onModified subscription alive.
        this.collab.dispose();
        this.connection?.dispose();
    }
}
