const registerStep = document.getElementById("registerStep");
const verifyStep = document.getElementById("verifyStep");
const doneStep = document.getElementById("doneStep");

const registerForm = document.getElementById("registerForm");
const regFullName = document.getElementById("regFullName");
const regEmail = document.getElementById("regEmail");
const regPhone = document.getElementById("regPhone");
const regDob = document.getElementById("regDob");
const regPassword = document.getElementById("regPassword");
const regPasswordConfirm = document.getElementById("regPasswordConfirm");
const registerError = document.getElementById("registerError");

const verifyForm = document.getElementById("verifyForm");
const verifyCode = document.getElementById("verifyCode");
const verifyError = document.getElementById("verifyError");
const verifyEmailLabel = document.getElementById("verifyEmailLabel");
const resendCodeBtn = document.getElementById("resendCodeBtn");
const doneMessage = document.getElementById("doneMessage");

const MIN_AGE = 18;
let pendingEmail = "";

function calculateAge(dateString) {
  const dob = new Date(dateString);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const monthDiff = now.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age;
}

function showStep(step) {
  registerStep.hidden = step !== "register";
  verifyStep.hidden = step !== "verify";
  doneStep.hidden = step !== "done";
}

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  registerError.textContent = "";

  if (regPassword.value !== regPasswordConfirm.value) {
    registerError.textContent = "Passwords do not match";
    return;
  }
  const age = calculateAge(regDob.value);
  if (age === null || age < MIN_AGE) {
    registerError.textContent = `You must be at least ${MIN_AGE} to register`;
    return;
  }

  try {
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_name: regFullName.value.trim(),
        email: regEmail.value.trim(),
        phone_number: regPhone.value.trim(),
        date_of_birth: regDob.value,
        password: regPassword.value
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Registration failed");
    pendingEmail = payload.email;
    verifyEmailLabel.textContent = pendingEmail;
    showStep("verify");
  } catch (error) {
    registerError.textContent = error.message;
  }
});

verifyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  verifyError.textContent = "";
  try {
    const response = await fetch("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: pendingEmail, code: verifyCode.value.trim() })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Verification failed");
    doneMessage.textContent = payload.message || "Verified. Your account is awaiting admin approval.";
    showStep("done");
  } catch (error) {
    verifyError.textContent = error.message;
  }
});

resendCodeBtn.addEventListener("click", async () => {
  verifyError.textContent = "";
  resendCodeBtn.disabled = true;
  try {
    const response = await fetch("/api/auth/resend-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: pendingEmail })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not resend code");
    verifyError.textContent = "A new code was sent.";
  } catch (error) {
    verifyError.textContent = error.message;
  } finally {
    setTimeout(() => { resendCodeBtn.disabled = false; }, 60 * 1000);
  }
});
