require("../load-env");

const https = require("https");

const keyId = String(process.env.ALPACA_API_KEY_ID || "").trim();
const secretKey = String(process.env.ALPACA_API_SECRET_KEY || "").trim();

if (!keyId || !secretKey) {
  console.error("Alpaca paper credentials are missing. Add them to .env, then run this check again.");
  process.exitCode = 1;
} else {
  const request = https.request({
    hostname: "paper-api.alpaca.markets",
    path: "/v2/account",
    method: "GET",
    headers: {
      Accept: "application/json",
      "APCA-API-KEY-ID": keyId,
      "APCA-API-SECRET-KEY": secretKey
    }
  }, (response) => {
    let body = "";
    response.on("data", (chunk) => {
      body += chunk;
    });
    response.on("end", () => {
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        payload = {};
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        console.error(`Alpaca paper authentication failed (${response.statusCode}): ${payload.message || "Check the paper API keys"}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Alpaca paper authentication succeeded. Account status: ${payload.status || "active"}.`);
      if (payload.account_blocked || payload.trading_blocked) {
        console.warn("The account authenticated, but Alpaca reports that trading is blocked.");
        process.exitCode = 1;
      }
    });
  });

  request.setTimeout(10_000, () => {
    request.destroy(new Error("Alpaca authentication check timed out"));
  });
  request.on("error", (error) => {
    console.error(`Alpaca paper authentication check failed: ${error.message}`);
    process.exitCode = 1;
  });
  request.end();
}
