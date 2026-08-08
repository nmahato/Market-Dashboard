(function () {
  const recommendation = document.getElementById("strategyRecommendation");
  const rationale = document.getElementById("strategyRationale");
  const metrics = document.getElementById("strategyMetrics");
  const action = document.getElementById("strategyAction");

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[character]));
  }

  function renderAnalysis(analysis) {
    const labels = {
      "covered-call": "Covered Call",
      "long-strangle": "Long Strangle",
      "bull-call-spread": "Bull Call Spread",
      "bear-put-spread": "Bear Put Spread",
      "iron-condor": "Iron Condor",
      wait: "Wait / No Clean Fit"
    };
    recommendation.textContent = `Best now: ${labels[analysis.recommendation] || analysis.recommendation} · ${analysis.confidence}% model confidence`;
    recommendation.className = `recommendation-${analysis.recommendation}`;
    rationale.textContent = analysis.rationale;
    const values = analysis.metrics || {};
    metrics.innerHTML = [
      ["RSI", values.rsi],
      ["20-day return", `${values.return20}%`],
      ["Realized volatility", `${values.realizedVolatility20}%`],
      ["Volatility expansion", `${values.volatilityExpansion}x`],
      ["EMA20 / EMA50", `${values.ema20} / ${values.ema50}`],
      ["As of", new Date(analysis.updatedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })]
    ].map(([label, value]) => `<span><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></span>`).join("");
    if (analysis.recommendation !== "wait") {
      action.hidden = false;
      action.href = analysis.recommendation === "covered-call"
        ? "/options.html"
        : analysis.recommendation === "long-strangle"
          ? "/strangle.html"
          : `/strategies.html?strategy=${encodeURIComponent(analysis.recommendation)}`;
      action.textContent = `Use best fit: ${labels[analysis.recommendation]}`;
    } else {
      action.hidden = true;
    }
  }

  async function loadAnalysis(symbol) {
    recommendation.textContent = `Analyzing ${symbol}...`;
    rationale.textContent = "Loading six months of daily price history.";
    metrics.innerHTML = "";
    action.hidden = true;
    const response = await fetch(`/api/options-analysis?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Analysis request failed with ${response.status}`);
    renderAnalysis(payload);
    return payload;
  }

  window.loadOptionStrategyAnalysis = loadAnalysis;
}());
