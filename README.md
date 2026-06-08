# Market RSI Dashboard

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
- `OVERSOLD`: RSI is below 30.
- `EXTENDED`: RSI is above 70.
- `WATCH`: no active signal.

The dashboard refreshes every 15 seconds.
