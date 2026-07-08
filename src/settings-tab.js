const { Notice, PluginSettingTab, Setting } = require("obsidian");

// Settings tab for board access, card-note sync, Nextcloud sync, support, and
// version info.
const { DONATION_URL } = require("./helpers");
const {
  normalizeServerUrl,
  startLoginFlow,
  pollLoginFlow,
  testConnection,
} = require("./nextcloud-auth");

const CONFLICT_OPTIONS = [
  { value: "prompt", label: "Ask me (recommended)" },
  { value: "local", label: "Keep local changes" },
  { value: "remote", label: "Keep remote (Nextcloud) changes" },
  { value: "newer-wins", label: "Keep whichever is newer" },
];

const SYNC_INTERVAL_OPTIONS = [
  { value: 30000, label: "Every 30 seconds" },
  { value: 60000, label: "Every minute" },
  { value: 300000, label: "Every 5 minutes" },
  { value: 900000, label: "Every 15 minutes" },
  { value: 0, label: "Manual only" },
];

/**
 * Obsidian settings tab for Obsidian Nextcloud Deck.
 */
class TaskDeckSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    // Live scratchpads for the Login Flow UI — kept on the tab instance so the
    // "Sign in with browser" button can cancel an in-flight poll from a second
    // click without losing the abort controller.
    this.pendingLoginController = null;
    this.pendingLoginTimer = null;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ot-settings");

    containerEl.createEl("h2", { text: "Obsidian Nextcloud Deck" });
    containerEl.createEl("p", {
      text: "Kanban boards backed by Markdown notes in your vault, with optional Nextcloud Deck sync.",
    });

    new Setting(containerEl)
      .setName("Board folders")
      .setDesc("Each board stores its Markdown cards in a folder named after that board.");

    new Setting(containerEl)
      .setName("Open board")
      .setDesc("Open the Nextcloud Deck board view.")
      .addButton((button) => {
        button
          .setButtonText("Open")
          .setCta()
          .onClick(() => this.plugin.activateView());
      });

    new Setting(containerEl)
      .setName("Sync card notes")
      .setDesc("Import Markdown cards created outside the board inside the card folder.")
      .addButton((button) => {
        button
          .setButtonText("Sync now")
          .onClick(async () => {
            await this.plugin.syncCardsFromFolder();
            this.plugin.refreshViews();
            new Notice("Nextcloud Deck synced.");
          });
      });

    this.renderNextcloudSection(containerEl);

    new Setting(containerEl)
      .setName("Completion sound")
      .setDesc("Play a short sound when a card is marked complete.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.data.completionSound !== false)
          .onChange(async (value) => {
            this.plugin.data.completionSound = value;
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Support development")
      .setDesc("Open the donation page.")
      .addButton((button) => {
        button
          .setButtonText("Donate")
          .onClick(() => window.open(DONATION_URL, "_blank"));
      });

    new Setting(containerEl)
      .setName("Version")
      .setDesc(this.plugin.manifest.version || "0.4.0");
  }

  hide() {
    // Abandon any in-flight browser login when the settings tab closes so a
    // stale poll can't overwrite fresh state next time the tab opens.
    this.cancelPendingLogin("Settings tab closed.");
  }

  // Nextcloud sync section --------------------------------------------------

  renderNextcloudSection(containerEl) {
    containerEl.createEl("h3", { text: "Nextcloud sync" });

    const nextcloud = this.plugin.data.nextcloud || {};
    const enabled = !!nextcloud.enabled;

    if (enabled) {
      this.renderSignedInState(containerEl, nextcloud);
    } else {
      this.renderSignedOutState(containerEl, nextcloud);
    }

    this.renderSyncPreferences(containerEl, nextcloud);
  }

  renderSignedInState(containerEl, nextcloud) {
    const desc = `Signed in as ${nextcloud.username || "(unknown)"} on ${nextcloud.serverUrl || "(no server)"}.`;

    new Setting(containerEl)
      .setName("Connection")
      .setDesc(desc)
      .addButton((button) => {
        button.setButtonText("Test connection").onClick(async () => {
          button.setDisabled(true);
          try {
            const password = await this.plugin.loadNextcloudAppPassword();
            if (!password) {
              new Notice("No stored App Password. Sign in again.");
              return;
            }
            const info = await testConnection(nextcloud.serverUrl, nextcloud.username, password);
            new Notice(`Nextcloud connection OK — ${info.displayName}`);
          } catch (error) {
            new Notice(`Connection failed: ${error.message}`);
          } finally {
            button.setDisabled(false);
          }
        });
      })
      .addButton((button) => {
        button
          .setButtonText("Sign out")
          .setWarning()
          .onClick(async () => {
            const confirmed = window.confirm(
              "Sign out and revoke the App Password on Nextcloud? Local boards and cards are kept.",
            );
            if (!confirmed) return;
            try {
              await this.plugin.signOutNextcloud();
              new Notice("Signed out of Nextcloud.");
            } catch (error) {
              new Notice(`Sign out failed: ${error.message}`);
            }
            this.display();
          });
      });

    // Pull-now + last-sync status. `runNextcloudSync` never rejects; it
    // reports through the sync manager's status object.
    const statusEl = containerEl.createEl("div", { cls: "ot-settings-inline-status" });
    statusEl.setText(this.formatSyncStatus(nextcloud));

    new Setting(containerEl)
      .setName("Pull from Nextcloud")
      .setDesc("Fetch remote boards, stacks, and cards. Read-only for now — pushes arrive in M3.")
      .addButton((button) => {
        button
          .setButtonText("Pull now")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            statusEl.setText("Pulling from Nextcloud…");
            const result = await this.plugin.runNextcloudSync({ manual: true });
            statusEl.setText(this.formatSyncStatus(this.plugin.data.nextcloud, result));
            button.setDisabled(false);
          });
      });
  }

  renderSignedOutState(containerEl, nextcloud) {
    // Server URL + login-flow launcher. The URL persists to data.json only
    // AFTER a successful sign-in, but we cache it on the tab so a failed
    // attempt doesn't require re-typing.
    let serverInput = this.draftServerUrl != null ? this.draftServerUrl : (nextcloud.serverUrl || "");
    new Setting(containerEl)
      .setName("Nextcloud server URL")
      .setDesc("Example: https://cloud.example.com")
      .addText((text) => {
        text.setPlaceholder("https://cloud.example.com");
        text.setValue(serverInput);
        text.onChange((value) => {
          this.draftServerUrl = value;
        });
      });

    // Live status line updated by the login flow poller.
    const status = containerEl.createEl("div", { cls: "ot-settings-inline-status" });
    status.setText("Not connected.");
    this.loginStatusEl = status;

    new Setting(containerEl)
      .setName("Sign in with browser")
      .setDesc("Uses Nextcloud Login Flow v2. A browser opens on the server so you can authorise this plugin; the App Password comes back automatically.")
      .addButton((button) => {
        button
          .setButtonText("Sign in with browser")
          .setCta()
          .onClick(() => this.beginBrowserLogin(button, serverInput));
      })
      .addButton((button) => {
        button
          .setButtonText("Cancel")
          .onClick(() => this.cancelPendingLogin("Cancelled by user."));
      });

    // App Password fallback for corporate proxies / users who prefer to paste.
    let manualUsername = "";
    let manualPassword = "";
    new Setting(containerEl)
      .setName("Or paste an App Password")
      .setDesc("Generate one at Nextcloud → Settings → Security → Devices & sessions.");
    new Setting(containerEl)
      .setName("Username")
      .addText((text) => {
        text.setPlaceholder("username");
        text.onChange((value) => { manualUsername = value.trim(); });
      });
    new Setting(containerEl)
      .setName("App Password")
      .addText((text) => {
        text.setPlaceholder("xxxx-xxxx-xxxx-xxxx");
        // Obsidian's TextComponent doesn't support type=password on all
        // versions; we mask via the underlying input element instead.
        try { text.inputEl.type = "password"; } catch (error) { /* older builds */ }
        text.onChange((value) => { manualPassword = value.trim(); });
      })
      .addButton((button) => {
        button
          .setButtonText("Save & test")
          .setCta()
          .onClick(async () => {
            const url = normalizeServerUrl(this.draftServerUrl != null ? this.draftServerUrl : nextcloud.serverUrl);
            if (!url) return new Notice("Enter a Nextcloud server URL first.");
            if (!manualUsername || !manualPassword) return new Notice("Enter both username and App Password.");
            button.setDisabled(true);
            try {
              await testConnection(url, manualUsername, manualPassword);
              await this.plugin.saveNextcloudCredentials({
                serverUrl: url,
                username: manualUsername,
                appPassword: manualPassword,
              });
              new Notice("Nextcloud connected.");
              this.draftServerUrl = undefined;
              this.display();
            } catch (error) {
              new Notice(`Connection failed: ${error.message}`);
            } finally {
              button.setDisabled(false);
            }
          });
      });
  }

  renderSyncPreferences(containerEl, nextcloud) {
    new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("How often to poll Nextcloud for remote changes.")
      .addDropdown((dropdown) => {
        SYNC_INTERVAL_OPTIONS.forEach((option) => dropdown.addOption(String(option.value), option.label));
        const current = Number(nextcloud.syncIntervalMs);
        const match = SYNC_INTERVAL_OPTIONS.find((option) => option.value === current);
        dropdown.setValue(match ? String(current) : "60000");
        dropdown.onChange(async (value) => {
          this.plugin.data.nextcloud = Object.assign({}, this.plugin.data.nextcloud, {
            syncIntervalMs: Number(value),
          });
          await this.plugin.saveData(this.plugin.data);
          this.plugin.scheduleNextcloudSync();
        });
      });

    new Setting(containerEl)
      .setName("Conflict resolution")
      .setDesc("What to do when both local and remote edited the same field of a card.")
      .addDropdown((dropdown) => {
        CONFLICT_OPTIONS.forEach((option) => dropdown.addOption(option.value, option.label));
        dropdown.setValue(nextcloud.conflictPolicy || "prompt");
        dropdown.onChange(async (value) => {
          this.plugin.data.nextcloud = Object.assign({}, this.plugin.data.nextcloud, {
            conflictPolicy: value,
          });
          await this.plugin.saveData(this.plugin.data);
        });
      });
  }

  formatSyncStatus(nextcloud, override) {
    const status = override || (this.plugin.syncManager && this.plugin.syncManager.getStatus()) || null;
    if (status && status.state === "running") return status.message || "Pulling…";
    if (status && status.state === "error") return `Pull failed: ${status.message}`;
    const last = Number((nextcloud && nextcloud.lastSyncAt) || (status && status.at) || 0);
    if (!last) return "No sync yet.";
    return `Last sync: ${new Date(last).toLocaleString()}`;
  }

  // Login flow orchestration ------------------------------------------------

  async beginBrowserLogin(button, initialServerUrl) {
    this.cancelPendingLogin("Superseded by a new login attempt.");

    const rawUrl = this.draftServerUrl != null ? this.draftServerUrl : initialServerUrl;
    const serverUrl = normalizeServerUrl(rawUrl);
    if (!serverUrl) {
      new Notice("Enter a Nextcloud server URL first.");
      return;
    }

    this.updateLoginStatus("Contacting Nextcloud…");
    button.setDisabled(true);

    let flow;
    try {
      flow = await startLoginFlow(serverUrl);
    } catch (error) {
      this.updateLoginStatus("");
      new Notice(`Login start failed: ${error.message}`);
      button.setDisabled(false);
      return;
    }

    this.updateLoginStatus("Waiting for the browser… complete the login there.");
    try {
      window.open(flow.login, "_blank");
    } catch (error) {
      // window.open can throw inside a mobile / restricted webview; we still
      // return the URL so the status line prompts the user to paste it.
      this.updateLoginStatus(`Open this URL in a browser: ${flow.login}`);
    }

    const controller = new AbortController();
    this.pendingLoginController = controller;

    try {
      const credentials = await pollLoginFlow(flow.poll, { signal: controller.signal });
      await this.plugin.saveNextcloudCredentials({
        serverUrl: credentials.server || flow.serverUrl,
        username: credentials.loginName,
        appPassword: credentials.appPassword,
      });
      new Notice(`Nextcloud connected as ${credentials.loginName}.`);
      this.draftServerUrl = undefined;
      this.display();
    } catch (error) {
      this.updateLoginStatus("");
      if (!controller.signal.aborted) new Notice(`Login failed: ${error.message}`);
    } finally {
      if (this.pendingLoginController === controller) this.pendingLoginController = null;
      button.setDisabled(false);
    }
  }

  cancelPendingLogin(reason) {
    if (this.pendingLoginController) {
      this.pendingLoginController.abort(reason || "Cancelled.");
      this.pendingLoginController = null;
      this.updateLoginStatus("Login cancelled.");
    }
  }

  updateLoginStatus(text) {
    if (this.loginStatusEl) this.loginStatusEl.setText(text || "Not connected.");
  }
}

module.exports = { TaskDeckSettingTab };
