const MODULE_ID = "Lorebound";

const Lorebound = {
    id: MODULE_ID,
    settingsKey: {
        oauthConfig: "oauthConfig",
        oauthToken: "oauthToken"
    },
    templatePaths: {
        settings: `modules/${MODULE_ID}/templates/settings.hbs`
    },
    log: (...args) => console.log("Lorebound |", ...args),
    warn: (...args) => console.warn("Lorebound |", ...args),
    error: (...args) => console.error("Lorebound |", ...args)
};

Hooks.once("init", () => {
    registerSettings();
    registerMenus();
    loadTemplates([Lorebound.templatePaths.settings]);
});

Hooks.once("ready", () => {
    Lorebound.sync = new LoreboundSync();
});

function registerSettings() {
    const defaultConfig = {
        clientSecret: "",
        redirectUrl: `${window.location.origin}/modules/${MODULE_ID}/oauth-callback.html`,
        scope: "openid profile"
    };

    game.settings.register(MODULE_ID, Lorebound.settingsKey.oauthConfig, {
        scope: "world",
        config: false,
        type: Object,
        default: defaultConfig
    });

    game.settings.register(MODULE_ID, Lorebound.settingsKey.oauthToken, {
        scope: "client",
        config: false,
        type: Object,
        default: null
    });
}

function registerMenus() {
    game.settings.registerMenu(MODULE_ID, "settingsMenu", {
        name: game.i18n.localize("LOREBOUND.Settings.MenuLabel"),
        label: game.i18n.localize("LOREBOUND.Settings.MenuLabel"),
        hint: game.i18n.localize("LOREBOUND.Settings.MenuHint"),
        icon: "fas fa-scroll",
        type: LoreboundSettingsForm,
        restricted: false
    });
}

class LoreboundSettingsForm extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "lorebound-settings",
            classes: ["lorebound", "sheet"],
            title: game.i18n.localize("LOREBOUND.Settings.MenuLabel"),
            template: Lorebound.templatePaths.settings,
            width: 520
        });
    }

    getData() {
        const config = LoreboundConfig.get();
        const token = LoreboundTokenStore.get();
        const status = LoreboundTokenStore.describe(token);
        return {
            config,
            status
        };
    }

    activateListeners(html) {
        super.activateListeners(html);
        html[0]?.querySelector("button[data-action='login']")?.addEventListener("click", (event) => {
            event.preventDefault();
            this._handleLogin();
        });
        html[0]?.querySelector("button[data-action='logout']")?.addEventListener("click", (event) => {
            event.preventDefault();
            this._handleLogout();
        });
    }

    async _updateObject(_event, formData) {
        const expanded = foundry.utils.expandObject(formData);
        await LoreboundConfig.set(expanded.config);
        ui.notifications.info(game.i18n.localize("LOREBOUND.Settings.Save"));
    }

    async _handleLogin() {
        try {
            const token = await LoreboundOAuth.authorize();
            if (token) {
                await LoreboundTokenStore.set(token);
                ui.notifications.info(game.i18n.localize("LOREBOUND.Settings.Status.Connected"));
                this.render(true);
            }
        } catch (error) {
            Lorebound.error("OAuth login failed", error);
            ui.notifications.error(game.i18n.localize("LOREBOUND.Sync.Notification.FetchError"));
        }
    }

    async _handleLogout() {
        await LoreboundTokenStore.clear();
        ui.notifications.info(game.i18n.localize("LOREBOUND.Settings.Status.Disconnected"));
        this.render(true);
    }
}

class LoreboundConfig {
    static get() {
        const current = game.settings.get(MODULE_ID, Lorebound.settingsKey.oauthConfig);
        return {
            clientId: "foundry_app",
            clientSecret: current?.clientSecret ?? "",
            worldId: current?.worldId ?? "",
            authorizeUrl: "https://auth.niclee.dev/authorize",
            tokenUrl: "https://auth.niclee.dev/token",
            apiBaseUrl: "https://apilorebound.niclee.dev/api",
            redirectUrl: current?.redirectUrl ?? `${window.location.origin}/modules/${MODULE_ID}/oauth-callback.html`,
            allowedJournals: current?.allowedJournals ?? null,
        };
    }

    static async set(config) {
        const merged = { ...this.get(), ...config };
        return game.settings.set(MODULE_ID, Lorebound.settingsKey.oauthConfig, merged);
    }
}

class LoreboundTokenStore {
    static get() {
        return game.settings.get(MODULE_ID, Lorebound.settingsKey.oauthToken);
    }

    static async set(token) {
        const normalized = this._normalize(token);
        return game.settings.set(MODULE_ID, Lorebound.settingsKey.oauthToken, normalized);
    }

    static async clear() {
        return game.settings.set(MODULE_ID, Lorebound.settingsKey.oauthToken, null);
    }

    static isExpired(token) {
        if (!token?.expires_at) return true;
        return Date.now() >= token.expires_at - 60_000;
    }

    static describe(token) {
        if (!token?.access_token) {
            return {
                icon: "fas fa-times-circle",
                label: game.i18n.localize("LOREBOUND.Settings.Status.Disconnected")
            };
        }
        const expires = token.expires_at ? new Date(token.expires_at).toLocaleString() : "";
        return {
            icon: "fas fa-check-circle",
            label: game.i18n.format("LOREBOUND.Settings.Status.TokenExpires", { time: expires })
        };
    }

    static _normalize(token) {
        if (!token) return null;
        const expiresAt = token.expires_in ? Date.now() + token.expires_in * 1000 : Date.now() + 3_600_000;
        return {
            ...token,
            expires_at: token.expires_at ?? expiresAt,
            received_at: token.received_at ?? Date.now()
        };
    }
}

class LoreboundOAuth {
    static storageKey = `${MODULE_ID}.pkce`;

    static async authorize() {
        const config = LoreboundConfig.get();
        this._assertConfig(config);
        const verifier = this._randomString(96);
        const challenge = await this._pkceChallenge(verifier);
        const state = this._randomString(24);
        const redirectUri = config.redirectUrl || `${window.location.origin}/modules/${MODULE_ID}/oauth-callback.html`;
        const params = new URLSearchParams({
            response_type: "code",
            client_id: config.clientId,
            redirect_uri: redirectUri,
            scope: config.scope || "openid profile",
            state,
            code_challenge: challenge,
            code_challenge_method: "S256"
        });
        const authorizeUrl = `${config.authorizeUrl}?${params.toString()}`;
        const stash = {
            verifier,
            state,
            issued: Date.now()
        };
        sessionStorage.setItem(this.storageKey, JSON.stringify(stash));
        const popup = window.open(authorizeUrl, "LoreboundOAuth", "width=500,height=700");
        if (!popup) throw new Error("Popup blocked");
        return new Promise((resolve, reject) => {
            const handler = async (event) => {
                if (event.origin !== window.location.origin) return;
                const data = event.data;
                if (!data || data.source !== "LoreboundOAuth") return;
                window.removeEventListener("message", handler);
                popup.close();
                if (data.error) {
                    reject(new Error(data.error_description || data.error));
                    return;
                }
                try {
                    const payload = JSON.parse(sessionStorage.getItem(this.storageKey) ?? "null");
                    sessionStorage.removeItem(this.storageKey);
                    if (!payload || payload.state !== data.state) throw new Error("State mismatch");
                    const token = await this._exchangeCode(data.code, payload.verifier, config);
                    resolve(token);
                } catch (error) {
                    reject(error);
                }
            };
            window.addEventListener("message", handler);
        });
    }

    static async refresh() {
        const config = LoreboundConfig.get();
        const token = LoreboundTokenStore.get();
        if (!token?.refresh_token) return null;
        try {
            const refreshed = await this._tokenRequest(config, {
                grant_type: "refresh_token",
                refresh_token: token.refresh_token,
                client_id: config.clientId,
                client_secret: config.clientSecret || undefined
            });
            return refreshed;
        } catch (error) {
            Lorebound.error("Token refresh failed", error);
            return null;
        }
    }

    static _assertConfig(config) {
        if (!config.clientId || !config.authorizeUrl || !config.tokenUrl) {
            throw new Error("OAuth configuration incomplete");
        }
    }

    static async _exchangeCode(code, verifier, config) {
        const redirectUri = config.redirectUrl || `${window.location.origin}/modules/${MODULE_ID}/oauth-callback.html`;
        const payload = {
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: config.clientId,
            code_verifier: verifier
        };
        if (config.clientSecret) payload.client_secret = config.clientSecret;
        return this._tokenRequest(config, payload);
    }

    static async _tokenRequest(config, body) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(body)) {
            if (value === undefined || value === null) continue;
            params.set(key, value);
        }
        const response = await fetch(config.tokenUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: params
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Token request failed: ${response.status} ${text}`);
        }
        return response.json();
    }

    static async _pkceChallenge(verifier) {
        const encoder = new TextEncoder();
        const data = encoder.encode(verifier);
        const digest = await crypto.subtle.digest("SHA-256", data);
        return this._base64UrlEncode(new Uint8Array(digest));
    }

    static _base64UrlEncode(bytes) {
        const binary = Array.from(bytes).map((b) => String.fromCharCode(b)).join("");
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    static _randomString(length) {
        const array = new Uint8Array(length);
        crypto.getRandomValues(array);
        return Array.from(array, (value) => (value % 36).toString(36)).join("");
    }
}

class LoreboundSync {
    constructor() {
        Hooks.on("createJournalEntryPage", this.createJournalEntry.bind(this));
        Hooks.on("updateJournalEntryPage", this.updateJournalEntry.bind(this));
        Hooks.on("deleteJournalEntryPage", this.deleteJournalEntry.bind(this));
    }

    get config() {
        const config = LoreboundConfig.get();
        if (config.allowedJournals && typeof config.allowedJournals === "string") {
            config.allowedJournals = config.allowedJournals.split(",").map(s => s.trim());
        }
        return config;
    }

    async ensureToken() {
        let token = LoreboundTokenStore.get();
        if (token && !LoreboundTokenStore.isExpired(token)) return token;
        if (token?.refresh_token) {
            const refreshed = await LoreboundOAuth.refresh();
            if (refreshed) {
                token = await LoreboundTokenStore.set(refreshed);
                return token;
            }
        }
        ui.notifications.warn(game.i18n.localize("LOREBOUND.Sync.Notification.TokenMissing"));
        return null;
    }

    async createJournalEntry(doc, options, userId) {
        Lorebound.log("Creating journal entry", doc);
        if (this.config.allowedJournals && !this.config.allowedJournals.includes(doc.parent.name)) {
            return;
        }
        const payload = {
            title: doc?.name,
            content: doc?.text?.content || "Content",
            worldId: this.config.worldId
        }
        const response = await this.makeRequest('/notes', 'POST', payload);
        doc.setFlag(MODULE_ID, 'externalId', response._id);
    }

    async updateJournalEntry(doc, updateData, options, userId) {
        Lorebound.log("Updating journal entry", doc, updateData);
        if (this.config.allowedJournals && !this.config.allowedJournals.includes(doc.parent.name)) {
            return;
        }
        const payload = {
            title: doc?.name,
            content: doc?.text?.content || "Content",
        }
        const externalId = doc.getFlag(MODULE_ID, 'externalId');
        if (!externalId) {
            Lorebound.warn("No externalId flag found on journal entry", doc, doc.getFlag(MODULE_ID, 'externalId'));
            return;
        };
        await this.makeRequest(`/notes/${externalId}`, 'PUT', payload);
    }

    async deleteJournalEntry(doc, options, userId) {
        Lorebound.log("Deleting journal entry", doc);
        if (this.config.allowedJournals && !this.config.allowedJournals.includes(doc.parent.name)) {
            return;
        }
        const externalId = doc.getFlag(MODULE_ID, 'externalId');
        if (!externalId) {
            Lorebound.warn("No externalId flag found on journal entry", doc, doc.getFlag(MODULE_ID, 'externalId'));
            return;
        };
        await this.makeRequest(`/notes/${externalId}`, 'DELETE');
    }

    async makeRequest(endpoint, method, payload) {
        const token = await this.ensureToken();
        if(!token) return;
        const url = `${this.config.apiBaseUrl}${endpoint}`;
        let response = await fetch(url, {
            method,
            headers: {
                "Content-Type": "application/json",
                Authorization: `${token.token_type || "Bearer"} ${token.access_token}`
            },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            Lorebound.warn("Lorebound api error", await response.text());
            ui.notifications.error(game.i18n.localize("LOREBOUND.Sync.Notification.FetchError"));
            return;
        }
        return response.json();
    }

}

globalThis.Lorebound = Lorebound;
