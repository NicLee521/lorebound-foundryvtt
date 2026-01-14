# Lorebound Foundry Module

This module connects Foundry VTT to the Lorebound website by authorizing through an OAuth 2.0 provider and syncing journal entries.

## Features
- Per-user OAuth 2.0 authorization with PKCE
- Token storage and automatic refresh handling when possible
- Manual journal sync button inside each journal sheet
- Configurable API endpoints and OAuth client settings

## Installation
1. Copy the module into your Foundry `Data/modules` directory or install it via manifest using the module URL provided in `module.json`.
2. Enable the module for your world.

## OAuth Provider Setup
1. Create an OAuth client in your provider dashboard.
2. Set the redirect URI to `https://YOUR-FOUNDRY-URL/modules/Lorebound/oauth-callback.html`.
3. Allow the scopes required by the Lorebound API.
4. If you must use a client secret, ensure you trust the Foundry host because secrets are stored server-side but remain visible to GMs.

## Foundry Configuration
1. Open *Configure Settings → Module Settings → Lorebound Integration*.
2. Enter the client ID (and secret if required) from your OAuth provider.
3. Provide the authorization endpoint, token endpoint, Lorebound API base URL, and journal sync endpoint path.
4. Save the settings, then click **Sign In** to authorize. Complete the OAuth flow in the popup.
5. Once connected, use **Send Test Sync** to validate connectivity.

## Syncing Journals
- Open any journal entry; a **Sync Lorebound** button appears in the header.
- Click it to send the journal payload (including pages) to your Lorebound API using the stored access token.

## API Expectations
- The journal payload is submitted as JSON to `<apiBaseUrl>/<journalEndpoint>` using an `Authorization: Bearer <token>` header.
- The payload structure includes `id`, `name`, `folder`, `tags`, `updatedAt`, `author`, and an array of page data.

## Development Notes
- The OAuth flow relies on browser popups; ensure popups are not blocked.
- Tokens are stored per Foundry user (`scope: client`). Refresh tokens are used automatically when provided.
- Custom behavior can be accessed through the global `Lorebound` object defined in `scripts/module.js`.
