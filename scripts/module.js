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
  log: (...args) => console.log(`Lorebound |`, ...args),
  warn: (...args) => console.warn(`Lorebound |`, ...args),
  error: (...args) => console.error(`Lorebound |`, ...args)
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
    clientId: "",
    clientSecret: "",
    authorizeUrl: "",
    tokenUrl: "",
    apiBaseUrl: "",
    journalEndpoint: "/api/foundry/journals",
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
    html[0]?.querySelector("button[data-action='test-sync']")?.addEventListener("click", async (event) => {
      event.preventDefault();
      await Lorebound.sync?.runTestSync();
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
      clientId: current?.clientId ?? "",
      clientSecret: current?.clientSecret ?? "",
      authorizeUrl: current?.authorizeUrl ?? "",
      tokenUrl: current?.tokenUrl ?? "",
      apiBaseUrl: current?.apiBaseUrl ?? "",
      journalEndpoint: current?.journalEndpoint ?? "/api/foundry/journals",
      redirectUrl: current?.redirectUrl ?? `${window.location.origin}/modules/${MODULE_ID}/oauth-callback.html`,
      scope: current?.scope ?? "openid profile"
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
    Hooks.on("getJournalSheetHeaderButtons", this._injectHeaderButton.bind(this));
  }

  get config() {
    return LoreboundConfig.get();
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

  async syncJournal(journal) {
    if (!journal) return;
    const token = await this.ensureToken();
    if (!token?.access_token) return;
    try {
      const payload = await this._buildJournalPayload(journal);
      const endpoint = this._resolveEndpoint();
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `${token.token_type || "Bearer"} ${token.access_token}`
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        Lorebound.warn("Lorebound sync error", await response.text());
        ui.notifications.error(game.i18n.localize("LOREBOUND.Sync.Notification.FetchError"));
        return;
      }
      ui.notifications.info(game.i18n.localize("LOREBOUND.Sync.Notification.Success"));
    } catch (error) {
      Lorebound.error("Lorebound sync failed", error);
      ui.notifications.error(game.i18n.localize("LOREBOUND.Sync.Notification.Error"));
    }
  }

  async runTestSync() {
    const journal = game.journal?.contents?.[0];
    if (!journal) {
      ui.notifications.warn("No journal entries available for test sync.");
      return;
    }
    await this.syncJournal(journal);
  }

  _injectHeaderButton(sheet, buttons) {
    const button = {
      label: game.i18n.localize("LOREBOUND.Sync.HeaderButton"),
      class: "lorebound-sync",
      icon: "fas fa-cloud-upload-alt",
      onclick: () => this.syncJournal(sheet.object)
    };
    buttons.unshift(button);
  }

  async _buildJournalPayload(journal) {
    await journal?.load();
    const pages = journal?.pages?.contents?.map((page) => ({
      id: page.id,
      name: page.name,
      type: page.type,
      text: page.text?.content ?? null,
      image: page.src ?? null,
      ownership: page.ownership ?? {}
    })) ?? [];
    return {
      id: journal.uuid,
      name: journal.name,
      folder: journal.folder?.name ?? null,
      tags: Array.from(journal.system?.tags ?? []),
      updatedAt: journal.updated ?? new Date().toISOString(),
      author: journal.author?.id ?? null,
      pages
    };
  }

  _resolveEndpoint() {
    const config = this.config;
    const base = (config.apiBaseUrl || "").replace(/\/$/, "");
    const path = config.journalEndpoint || "/api/foundry/journals";
    return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
  }
}

globalThis.Lorebound = Lorebound;
