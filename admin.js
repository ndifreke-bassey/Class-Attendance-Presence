"use strict";

const byId = (id) => document.getElementById(id);
let invitationUrl = "";
let recoveryUrl = "";
let toastTimer;

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The server returned an unreadable response.");
  }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function showToast(message) {
  const toast = byId("admin-toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3500);
}

function renderLecturers(lecturers) {
  byId("admin-lecturer-count").textContent = String(lecturers.length);
  byId("admin-no-lecturers").hidden = lecturers.length > 0;
  byId("admin-lecturer-rows").innerHTML = lecturers.map((lecturer) =>
    `<tr><td><strong>${escapeHtml(lecturer.name)}</strong></td><td>${escapeHtml(lecturer.email)}</td><td>${lecturer.classCount}</td><td><span class="admin-invite-status ${lecturer.active ? "" : "is-expired"}">${lecturer.active ? "Active" : "Suspended"}</span></td><td><button class="admin-toggle" type="button" data-toggle-lecturer="${escapeHtml(lecturer.id)}" data-disabled="${lecturer.active}">${lecturer.active ? "Suspend" : "Reactivate"}</button>${lecturer.active ? `<button class="admin-recovery" type="button" data-recovery="${escapeHtml(lecturer.id)}">Issue reset link</button>` : ""}</td></tr>`
  ).join("");
}

function renderInvitations(invitations) {
  byId("admin-invite-count").textContent = String(invitations.length);
  byId("admin-no-invites").hidden = invitations.length > 0;
  byId("admin-invite-rows").innerHTML = invitations.map((invitation) => {
    const expired = invitation.expired;
    return `<tr><td><span class="admin-invite-status ${expired ? "is-expired" : ""}">${expired ? "Expired" : "Unused"}</span></td><td>${escapeHtml(formatDate(invitation.createdAt))}</td><td>${escapeHtml(formatDate(invitation.expiresAt))}</td><td><button class="admin-revoke" type="button" data-revoke="${escapeHtml(invitation.id)}">Revoke</button></td></tr>`;
  }).join("");
}

async function refreshDashboard() {
  byId("admin-error").textContent = "";
  const [accounts, invitations] = await Promise.all([
    api("/api/admin/lecturers"),
    api("/api/admin/invitations")
  ]);
  renderLecturers(accounts.lecturers);
  renderInvitations(invitations.invitations);
}

async function showDashboard() {
  await refreshDashboard();
  byId("admin-auth-view").hidden = true;
  byId("admin-dashboard").hidden = false;
  byId("admin-logout").hidden = false;
}

async function start() {
  try {
    const status = await api("/api/admin/status");
    if (status.authenticated) {
      await showDashboard();
      return;
    }
    if (!status.configured) {
      byId("admin-config-notice").textContent =
        "Owner access is not configured. Set PRESENCE_ADMIN_PASSWORD to a private password with at least 16 characters, then restart the server.";
      byId("admin-config-notice").hidden = false;
      byId("admin-login-submit").disabled = true;
    }
  } catch (error) {
    byId("admin-login-error").textContent = error.message;
  }
}

byId("admin-login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  byId("admin-login-error").textContent = "";
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: byId("admin-password").value })
    });
    byId("admin-password").value = "";
    await showDashboard();
  } catch (error) {
    byId("admin-login-error").textContent = error.message;
  }
});

byId("admin-copy-recovery").addEventListener("click", () => {
  if (!navigator.clipboard?.writeText) {
    byId("admin-error").textContent = "Clipboard access is unavailable in this browser. Copy the recovery link above.";
    return;
  }
  navigator.clipboard.writeText(recoveryUrl)
    .then(() => showToast("Password recovery link copied."))
    .catch(() => {
      byId("admin-error").textContent = "Clipboard access is unavailable in this browser. Copy the recovery link above.";
    });
});

byId("admin-create-invite").addEventListener("click", async () => {
  byId("admin-error").textContent = "";
  byId("admin-create-invite").disabled = true;
  try {
    const invitation = await api("/api/admin/invitations", { method: "POST", body: "{}" });
    const signup = new URL("/lecturer/activate", window.location.origin);
    signup.searchParams.set("invite", invitation.code);
    invitationUrl = signup.toString();
    byId("admin-invite-link").textContent = invitationUrl;
    byId("admin-invite-expiry").textContent = `Expires ${formatDate(invitation.expiresAt)} · single use`;
    byId("admin-invite-result").hidden = false;
    await refreshDashboard();
  } catch (error) {
    byId("admin-error").textContent = error.message;
  } finally {
    byId("admin-create-invite").disabled = false;
  }
});

byId("admin-copy-invite").addEventListener("click", () => {
  if (!navigator.clipboard?.writeText) {
    byId("admin-error").textContent = "Clipboard access is unavailable in this browser. Copy the invitation link above.";
    return;
  }
  navigator.clipboard.writeText(invitationUrl)
    .then(() => showToast("Invitation link copied."))
    .catch(() => {
      byId("admin-error").textContent = "Clipboard access is unavailable in this browser. Copy the invitation link above.";
    });
});

byId("admin-invite-rows").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-revoke]");
  if (!button || !window.confirm("Revoke this unused lecturer invitation?")) return;
  button.disabled = true;
  byId("admin-error").textContent = "";
  try {
    await api(`/api/admin/invitations/${encodeURIComponent(button.dataset.revoke)}`, { method: "DELETE" });
    await refreshDashboard();
    showToast("Invitation revoked.");
  } catch (error) {
    button.disabled = false;
    byId("admin-error").textContent = error.message;
  }
});

byId("admin-lecturer-rows").addEventListener("click", async (event) => {
  const recoveryButton = event.target.closest("[data-recovery]");
  if (recoveryButton) {
    recoveryButton.disabled = true;
    byId("admin-error").textContent = "";
    try {
      const result = await api(`/api/admin/lecturers/${encodeURIComponent(recoveryButton.dataset.recovery)}/recovery`, {
        method: "POST",
        body: "{}"
      });
      const reset = new URL("/lecturer/reset", window.location.origin);
      reset.searchParams.set("token", result.token);
      recoveryUrl = reset.toString();
      byId("admin-recovery-link").textContent = recoveryUrl;
      byId("admin-recovery-expiry").textContent = `Expires ${formatDate(result.expiresAt)} · single use`;
      byId("admin-recovery-result").hidden = false;
      showToast("One-time password reset link created.");
    } catch (error) {
      byId("admin-error").textContent = error.message;
    } finally {
      recoveryButton.disabled = false;
    }
    return;
  }
  const button = event.target.closest("[data-toggle-lecturer]");
  if (!button) return;
  const disabling = button.dataset.disabled === "true";
  const action = disabling ? "suspend" : "reactivate";
  if (!window.confirm(`${action === "suspend" ? "Suspend" : "Reactivate"} this lecturer account?${disabling ? " They will be signed out immediately; their class and attendance records will be retained." : ""}`)) return;
  button.disabled = true;
  byId("admin-error").textContent = "";
  try {
    await api(`/api/admin/lecturers/${encodeURIComponent(button.dataset.toggleLecturer)}`, {
      method: "PATCH",
      body: JSON.stringify({ disabled: disabling })
    });
    await refreshDashboard();
    showToast(`Lecturer account ${disabling ? "suspended" : "reactivated"}.`);
  } catch (error) {
    button.disabled = false;
    byId("admin-error").textContent = error.message;
  }
});

byId("admin-refresh").addEventListener("click", () =>
  refreshDashboard().catch((error) => { byId("admin-error").textContent = error.message; })
);

byId("admin-logout").addEventListener("click", async () => {
  try {
    await api("/api/admin/logout", { method: "POST", body: "{}" });
    byId("admin-dashboard").hidden = true;
    byId("admin-logout").hidden = true;
    byId("admin-auth-view").hidden = false;
  } catch (error) {
    byId("admin-error").textContent = error.message;
  }
});

start();
