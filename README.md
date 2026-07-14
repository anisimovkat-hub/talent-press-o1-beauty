# Talent Press O-1 Beauty Landing

Static landing page for Talent Press O-1 visa services for beauty specialists.

## Structure

- `index.html` — production landing page
- `assets/` — local images used by the page
- `public/` — deploy-ready copy used by Cloudflare Pages
- `functions/api/lead.js` — lead delivery endpoint for all forms
- `functions/api/amo/oauth.js` — amoCRM OAuth callback endpoint

## Cloudflare Pages

Recommended setup:

- Framework preset: `None`
- Build command: leave empty
- Build output directory: `public`
- Production branch: `main`

Every push to `main` can be deployed automatically by Cloudflare Pages.

## Critical Lead Integrations

Do not remove or bypass the form submission flow that sends requests to:

- `POST /api/lead`

This endpoint is responsible for delivering every new lead to:

- Telegram leads chat
- amoCRM

The integration depends on Cloudflare Pages secrets and KV:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `AMO_SUBDOMAIN`
- `AMO_CLIENT_ID`
- `AMO_CLIENT_SECRET`
- `AMO_REDIRECT_URI`
- KV binding `AMO_TOKENS`

When making future landing-page edits, preserve:

- the `/api/lead` endpoint
- the `submitLead(...)` calls in the page JavaScript
- successful-form logic that calls `fireConv()` for the Meta Pixel Lead event
- the `functions/api/amo/oauth.js` callback used to refresh amoCRM access
- the `AMO_TOKENS` KV binding in `wrangler.toml`
- amoCRM lead field population in `functions/api/lead.js`: lead data should be written into amoCRM deal/contact fields and tags, with notes used only as a backup copy of the full request

After any change that touches forms, scripts, Cloudflare Functions, or `wrangler.toml`, send a clearly marked test lead and verify that it appears in both Telegram and amoCRM before considering the work complete.
