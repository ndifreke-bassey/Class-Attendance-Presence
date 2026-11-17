"use strict";

const byId = (id) => document.getElementById(id);
const token = new URLSearchParams(window.location.search).get("token") || "";
if (token) window.history.replaceState(null, "", window.location.pathname);

byId("recovery-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  byId("recovery-error").textContent = "";
  const password = byId("recovery-password").value;
  if (!token) {
    byId("recovery-error").textContent = "This recovery link is missing its token. Ask the site owner for a new link.";
    return;
  }
  if (password !== byId("recovery-confirm").value) {
    byId("recovery-error").textContent = "The passwords do not match.";
    return;
  }
  const button = byId("recovery-submit");
  button.disabled = true;
  try {
    const response = await fetch("/api/auth/recovery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    byId("recovery-form").innerHTML = '<div class="section-kicker">PASSWORD UPDATED</div><h1>You can sign in now</h1><p>Your password has been changed. Sign in with the new password.</p><a class="button button-primary auth-submit" href="/">Go to lecturer sign in</a>';
  } catch (error) {
    byId("recovery-error").textContent = error.message;
    button.disabled = false;
  }
});
