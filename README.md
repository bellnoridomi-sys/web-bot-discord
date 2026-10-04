# Aki Dev — Discord Control

Full-stack Discord bot + web dashboard, styled monochrome/cinematic. The backend and bot run in one Node.js service so the web can issue real actions through the same process.

## Features

26 real bot features via slash commands:

`/ping` · `/help` · `/server` · `/userinfo` · `/avatar` · `/botinfo` · `/poll` · `/8ball` · `/roll` · `/coinflip` · `/remind` · `/afk` · `/warn` · `/warnings` · `/clear` · `/slowmode` · `/lock` · `/unlock` · `/kick` · `/ban` · `/timeout` · `/role` · `/announce` · `/vc-join` · `/vc-leave` · `/auto-voice`

The web dashboard has guild selection, live runtime metrics, voice controls, command lab, activity feed, Discord OAuth, Google OAuth, and animated 3D UI.

## Important

The code never asks users for or stores a Discord account token. Use official bot OAuth and the Discord Developer Portal.

Render's Free web service can sleep after 15 minutes with no inbound traffic, so Free is good for testing but not for real 24/7 voice uptime.

## Local setup

1. Copy `.env.example` to `.env`.
2. Fill the Discord bot and OAuth credentials.
3. Put a Postgres URL in `DATABASE_URL` or leave it empty for an in-memory fallback.
4. `npm install`
5. `npm start`

Open `http://localhost:10000`.

## Discord Developer Portal

Create an Application + Bot and copy:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`

Enable the Gateway intents used by this project, including Message Content for the prefix/AFK message listener.

OAuth2 redirect:

- Discord: `https://YOUR-DOMAIN/auth/discord/callback`

Invite the bot to your server with `bot` + `applications.commands` scopes and the permissions needed by the moderation/voice features you want to use.

## Google OAuth

Create a Google OAuth Web client.

Redirect URI:

- `https://YOUR-DOMAIN/auth/google/callback`

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

Google-only sessions do not know the user's Discord guild permissions; use Discord login for server control. The Google button is included so the dashboard itself supports Google OAuth.

## Render

This repo includes `render.yaml` for a Web Service + Postgres.

Deploy from GitHub with Render Blueprint. Set secret environment variables in the Render Dashboard:

`DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

After Render gives you the final service URL, update `SITE_URL` and the OAuth redirect URIs to the exact public URL. If you change the service name/domain, change the `SITE_URL` value in Render.

For 24/7 bot + voice, use a plan that does not sleep.
