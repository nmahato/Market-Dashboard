# Market Dashboard

Local real-time dashboard for monitoring a top-10 stock watchlist with 14-period RSI.

## Run

```powershell
npm start
```

Open:

```text
http://localhost:4177
```

## Signals

- `BUY SIGNAL`: RSI crossed back above 30 after being below 30.
- `SELL SIGNAL`: RSI crossed back below 70 after being extended.
- `OVERSOLD`: RSI is below 30.
- `EXTENDED`: RSI is above 70.
- `WATCH`: no active signal.

The dashboard refreshes every 5 seconds.

## Daily top 10 watchlist

Each day the server refreshes the RSI Watch list from Yahoo Finance `most_actives` and tracks the top 10 symbols of the day. Manually added symbols are kept in addition to that daily top 10 until the server restarts. Check or force-refresh the list at `/api/top-stocks`; use `/api/top-stocks?refresh=1` to refresh immediately.

## Crossover notifications

The server can send text and email notifications when `BUY SIGNAL` or `SELL SIGNAL` crossovers appear. Configure these as environment variables locally or in Render.

Email uses SendGrid:

```text
SENDGRID_API_KEY=...
NOTIFY_EMAIL_FROM=alerts@example.com
NOTIFY_EMAIL_TO=you@example.com,another@example.com
```

Text messages use Twilio:

```text
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM=+15551234567
NOTIFY_SMS_TO=+15557654321,+15559876543
```

Optional controls:

```text
NOTIFICATION_ENABLED=true
NOTIFICATION_COOLDOWN_MS=900000
NOTIFICATION_WEBHOOK_URL=https://example.com/market-alert-webhook
ADMIN_TOKEN=choose-a-private-admin-token
```

Check notification setup at `/api/notifications`. Alerts are rate-limited per symbol and signal type by `NOTIFICATION_COOLDOWN_MS`.

### WhatsApp groups

Open `/admin.html` to add WhatsApp group notification webhooks. The group must have a bot or provider that gives you an HTTPS webhook URL; the dashboard posts crossover alert JSON to that URL. If `ADMIN_TOKEN` is set, enter that token on the Admin page before adding or disabling groups.

## SQLite snapshots

On startup the server creates a SQLite database at `data/market-watch.sqlite`, or at `SQLITE_DB_PATH` if that environment variable is set. Every `/api/market` refresh inserts the latest watchlist rows into the `market_snapshots` table.

## CI/CD

GitHub Actions runs `npm ci` and `npm run build` on pushes and pull requests. Render auto-deploy is enabled in `render.yaml`; add a GitHub secret named `RENDER_DEPLOY_HOOK_URL` if you want Actions to trigger a Render deploy hook after the build succeeds on `developer`.
