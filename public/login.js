const loginForm = document.getElementById("loginForm");
const loginUsername = document.getElementById("loginUsername");
const loginPassword = document.getElementById("loginPassword");
const loginError = document.getElementById("loginError");
const guestButton = document.getElementById("guestButton");

const queryParams = new URLSearchParams(window.location.search);
const nextPath = queryParams.get("next");

function isSafeNextPath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//");
}

function goToNext() {
  window.location.href = isSafeNextPath(nextPath) ? nextPath : "/index.html";
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const email = loginUsername.value.trim();
  const password = loginPassword.value;
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Sign in failed");
    goToNext();
  } catch (error) {
    loginError.textContent = error.message;
  }
});

guestButton.addEventListener("click", async () => {
  loginError.textContent = "";
  try {
    const response = await fetch("/api/auth/guest", { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not start guest session");
    goToNext();
  } catch (error) {
    loginError.textContent = error.message;
  }
});
