# Market Dashboard

Local real-time dashboard for monitoring a top-10 stock watchlist with 14-period RSI.

## Run

```powershell
npm start
```

Open:

```text
http://localhost:4178
```

## Signals

- `BUY SIGNAL`: RSI crossed back above 30 after being below 30.
- `SELL SIGNAL`: RSI crossed back below 70 after being extended.
- `OVERSOLD`: RSI is below 30.
- `EXTENDED`: RSI is above 70.
- `WATCH`: no active signal.

The dashboard refreshes every 5 seconds.

## Daily top 10 watchlist

Each day the server refreshes the Daily Top 10 list from Yahoo Finance `most_actives`. The Admin page can also add stocks manually by company name or ticker symbol; autocomplete results show both. Added tickers are selected immediately and stored in SQLite. Check the automatic or manual stocks you want and select **Save Watchlist**; only selected symbols appear on RSI Watch. Check or force-refresh the automatic list at `/api/top-stocks`; use `/api/top-stocks?refresh=1` to refresh immediately.

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

## Alpaca paper trading

The dashboard can send RSI crossover orders to an Alpaca paper account. It is disabled unless all settings below are present:

```text
ALPACA_API_KEY_ID=your-paper-key
ALPACA_API_SECRET_KEY=your-paper-secret
ALPACA_PAPER_TRADING_ENABLED=true
ALPACA_ALLOWED_SYMBOLS=AAPL,MSFT,NVDA
ALPACA_BUY_NOTIONAL=100
ALPACA_MAX_DAILY_ORDERS=3
```

Use paper-account credentials only. `BUY SIGNAL` submits a market buy for the configured notional. `SELL SIGNAL` closes an existing long position and never opens a short. Orders run only while Alpaca reports the market open, only for explicitly allowed symbols, and at most once per symbol and signal each New York trading date. Execution attempts are stored in `paper_trade_executions`; status is available at `/api/trading` and on the Admin page.

Start with `ALPACA_PAPER_TRADING_ENABLED=false`, confirm the Admin page shows the expected paper configuration, and enable it only after reviewing the symbol allowlist and limits.

For a local PowerShell session, set the values before starting the server:

```powershell
$env:ALPACA_API_KEY_ID="your-paper-key"
$env:ALPACA_API_SECRET_KEY="your-paper-secret"
$env:ALPACA_ALLOWED_SYMBOLS="AAPL,MSFT,NVDA"
$env:ALPACA_PAPER_TRADING_ENABLED="false"
npm start
```

Restart the server after changing any trading setting. Never commit paper-account keys to the repository.

### Bulk paper orders

The Admin page includes an **Alpaca Paper Trading** bulk Buy/Sell section. It lists only stocks that are both selected for RSI Watch and present in `ALPACA_ALLOWED_SYMBOLS`. Bulk buys use `ALPACA_BUY_NOTIONAL` for each selected stock. Bulk sells close existing long positions and do not open shorts. Every submission requires browser confirmation and shares the configured daily order limit. A symbol can receive one manual bulk buy and one manual bulk sell per New York trading date.

## CI/CD

GitHub Actions runs `npm ci` and `npm run build` on pushes and pull requests. Render auto-deploy is enabled in `render.yaml`; add a GitHub secret named `RENDER_DEPLOY_HOOK_URL` if you want Actions to trigger a Render deploy hook after the build succeeds on `developer`.
