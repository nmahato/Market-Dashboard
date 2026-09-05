const usersStatus = document.getElementById("usersStatus");
const usersList = document.getElementById("usersList");
const userCount = document.getElementById("userCount");
const addUserBtn = document.getElementById("addUserBtn");

const userModal = document.getElementById("userModal");
const userModalClose = document.getElementById("userModalClose");
const userModalTitle = document.getElementById("userModalTitle");
const userModalError = document.getElementById("userModalError");
const userForm = document.getElementById("userForm");
const userFormSubmit = document.getElementById("userFormSubmit");
const modalUsername = document.getElementById("modalUsername");
const modalEmail = document.getElementById("modalEmail");
const modalFullName = document.getElementById("modalFullName");
const modalPhone = document.getElementById("modalPhone");
const modalDob = document.getElementById("modalDob");
const modalPassword = document.getElementById("modalPassword");
const modalPasswordLabel = document.getElementById("modalPasswordLabel");
const modalRole = document.getElementById("modalRole");
const modalStatus = document.getElementById("modalStatus");
const modalEmailVerified = document.getElementById("modalEmailVerified");
const modalPhoneVerified = document.getElementById("modalPhoneVerified");

let currentUser = null;
let latestUsers = [];
let editingUserId = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
  return payload;
}

function verifiedCell(emailVerifiedAt, phoneVerifiedAt) {
  const email = emailVerifiedAt ? '<span class="badge BUY_SIGNAL">Email</span>' : '<span class="badge WATCH">Email</span>';
  const phone = phoneVerifiedAt ? '<span class="badge BUY_SIGNAL">Phone</span>' : '<span class="badge WATCH">Phone</span>';
  return `<div class="admin-verify-row">${email}${phone}</div>`;
}

function renderUsers(users) {
  latestUsers = users;
  userCount.textContent = `${users.length} user${users.length === 1 ? "" : "s"}`;
  if (!users.length) {
    usersList.innerHTML = '<tr><td colspan="8" class="loading">No users yet.</td></tr>';
    return;
  }
  const isSelf = (user) => currentUser && user.username === currentUser.username;
  usersList.innerHTML = users.map((user) => `
    <tr data-user-id="${user.id}">
      <td>${escapeHtml(user.fullName || user.username)}</td>
      <td>${escapeHtml(user.email || "--")}</td>
      <td>${escapeHtml(user.phoneNumber || "--")}</td>
      <td><span class="badge ${user.role === "admin" ? "BUY_SIGNAL" : "WATCH"}">${escapeHtml(user.role)}</span></td>
      <td><span class="badge ${user.status === "active" ? "BUY_SIGNAL" : user.status === "pending" ? "WATCH" : "SELL_SIGNAL"}">${escapeHtml(user.status)}</span></td>
      <td>${verifiedCell(user.emailVerifiedAt, user.phoneVerifiedAt)}</td>
      <td>${escapeHtml(String(user.createdAt || "").slice(0, 10))}</td>
      <td>
        <button type="button" class="secondary-btn" data-edit-user="${user.id}">Edit</button>
        ${!isSelf(user) ? `<button type="button" class="secondary-btn" data-remove-user="${user.id}">Remove</button>` : ""}
      </td>
    </tr>
  `).join("");
}

async function loadUsers() {
  try {
    const payload = await requestJson("/api/admin/users");
    renderUsers(payload.users || []);
  } catch (error) {
    usersList.innerHTML = `<tr><td colspan="8" class="loading">${escapeHtml(error.message)}</td></tr>`;
  }
}

function openModal() {
  userModal.hidden = false;
  userModalError.textContent = "";
  modalUsername.focus();
}

function closeModal() {
  userModal.hidden = true;
}

function openAddModal() {
  editingUserId = null;
  userModalTitle.textContent = "Add User";
  userFormSubmit.textContent = "Add User";
  userForm.reset();
  modalPasswordLabel.textContent = "Password";
  modalPassword.required = true;
  modalStatus.value = "active";
  modalRole.value = "user";
  openModal();
}

function openEditModal(user) {
  editingUserId = user.id;
  userModalTitle.textContent = `Edit ${user.username}`;
  userFormSubmit.textContent = "Save Changes";
  modalUsername.value = user.username || "";
  modalEmail.value = user.email || "";
  modalFullName.value = user.fullName || "";
  modalPhone.value = user.phoneNumber || "";
  modalDob.value = "";
  modalPassword.value = "";
  modalPasswordLabel.textContent = "New password (leave blank to keep current)";
  modalPassword.required = false;
  modalRole.value = user.role || "user";
  modalStatus.value = user.status || "active";
  modalEmailVerified.checked = Boolean(user.emailVerifiedAt);
  modalPhoneVerified.checked = Boolean(user.phoneVerifiedAt);
  openModal();
}

addUserBtn.addEventListener("click", openAddModal);
userModalClose.addEventListener("click", closeModal);
userModal.addEventListener("click", (event) => {
  if (event.target === userModal) closeModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !userModal.hidden) closeModal();
});

userForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  userModalError.textContent = "";
  const body = {
    username: modalUsername.value.trim(),
    email: modalEmail.value.trim(),
    full_name: modalFullName.value.trim(),
    phone_number: modalPhone.value.trim(),
    date_of_birth: modalDob.value,
    role: modalRole.value
  };
  if (modalPassword.value) body.password = modalPassword.value;

  try {
    let payload;
    if (editingUserId === null) {
      payload = await requestJson("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      usersStatus.textContent = "User added.";
    } else {
      body.status = modalStatus.value;
      body.email_verified = modalEmailVerified.checked;
      body.phone_verified = modalPhoneVerified.checked;
      payload = await requestJson(`/api/admin/users/${editingUserId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      usersStatus.textContent = "User updated.";
    }
    renderUsers(payload.users || []);
    closeModal();
  } catch (error) {
    userModalError.textContent = error.message;
  }
});

usersList.addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-user]");
  const removeButton = event.target.closest("[data-remove-user]");

  if (editButton) {
    const user = latestUsers.find((item) => item.id === Number(editButton.dataset.editUser));
    if (user) openEditModal(user);
    return;
  }

  if (removeButton) {
    if (!window.confirm("Remove this user?")) return;
    try {
      const payload = await requestJson(`/api/admin/users/${removeButton.dataset.removeUser}`, { method: "DELETE" });
      usersStatus.textContent = "User removed.";
      renderUsers(payload.users || []);
    } catch (error) {
      usersStatus.textContent = error.message;
    }
  }
});

document.addEventListener("account:ready", (event) => {
  currentUser = event.detail;
  if (currentUser && currentUser.role === "admin") {
    loadUsers();
  } else {
    usersStatus.textContent = "Sign in as an admin to manage users.";
    usersList.innerHTML = '<tr><td colspan="8" class="loading">Sign in as an admin to manage users.</td></tr>';
  }
});
