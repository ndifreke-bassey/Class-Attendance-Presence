"use strict";

const byId = (id) => document.getElementById(id);
const state = {
  lecturer: null,
  courses: [],
  course: null,
  students: [],
  attendance: [],
  audit: [],
  session: null,
  managementToken: "",
  countdownTimer: null,
  refreshTimer: null,
  toastTimer: null,
  refreshing: false,
  loaded: false,
  editingCourse: false
};

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

function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3500);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function presentForSession(studentId) {
  return Boolean(state.session && state.attendance.some((record) =>
    record.sessionId === state.session.id && record.studentId === studentId
  ));
}

function renderCourse() {
  const course = state.course;
  const picker = byId("course-picker");
  picker.hidden = state.courses.length < 2;
  byId("course-select").innerHTML = state.courses.map((entry) =>
    `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.code)} · ${escapeHtml(entry.name)}</option>`
  ).join("");
  if (course) byId("course-select").value = course.id;
  byId("course-banner").hidden = !course;
  byId("course-empty").hidden = Boolean(course);
  byId("course-code").textContent = course ? `${course.code} · CLASS` : "";
  byId("course-name").textContent = course?.name || "";
  byId("course-room").textContent = course?.room || "";
  byId("course-lecturer").textContent = course?.lecturer || "";
  byId("course-radius").textContent = course ? `${course.radiusMeters} m radius` : "";
  byId("reports-panel").hidden = !course;
  byId("audit-panel").hidden = !course;
  updateReportActions();
  byId("edit-course").textContent = course ? "Edit class" : "Set up class";
  byId("create-course").hidden = !course;
  byId("generate-session").disabled = !course || state.students.length === 0 || Boolean(state.session);
  byId("edit-course").disabled = Boolean(state.session);
  byId("add-student").disabled = !course || Boolean(state.session);
}

function renderRoster() {
  const query = byId("roster-search").value.trim().toLowerCase();
  const rows = state.students.filter((student) =>
    `${student.name} ${student.id} ${student.program}`.toLowerCase().includes(query)
  );
  byId("roster-count").textContent = String(state.students.length);
  byId("enrolled-count").textContent = String(state.students.length);
  byId("roster-footer-count").textContent = `${rows.length} of ${state.students.length} students`;
  byId("empty-roster").hidden = rows.length > 0;
  byId("empty-roster").querySelector("strong").textContent = state.students.length && query
    ? "No students match your search"
    : "No students on this roster yet";
  byId("empty-roster").querySelector("span").textContent = state.students.length && query
    ? "Try another name or registration number."
    : "Add students to prepare this class for attendance.";
  byId("roster-body").innerHTML = rows.map((student) => {
    const present = presentForSession(student.id);
    return `<tr><td><span class="roster-person"><span class="roster-avatar">${escapeHtml(initials(student.name))}</span><span><strong>${escapeHtml(student.name)}</strong><small>${escapeHtml(student.program)}</small></span></span></td><td class="reg-number">${escapeHtml(student.id)}</td><td><span class="attendance-status ${present ? "status-present" : "status-waiting"}">${present ? "Present" : "Not checked in"}</span></td><td><button class="remove-student" type="button" data-remove="${escapeHtml(student.id)}" aria-label="Remove ${escapeHtml(student.name)} from roster">···</button></td></tr>`;
  }).join("");
  const rosterIds = new Set(state.students.map((student) => student.id));
  const presentCount = state.session
    ? state.attendance.filter((record) => record.sessionId === state.session.id && rosterIds.has(record.studentId)).length
    : 0;
  byId("present-count").textContent = String(presentCount);
  byId("present-caption").textContent = state.session
    ? `${Math.max(0, state.students.length - presentCount)} students not checked in`
    : "Attendance for the next session";
  renderCourse();
}

function renderAudit() {
  const events = state.audit || [];
  const correctionActions = new Set();
  byId("audit-empty").hidden = events.length > 0;
  byId("audit-body").innerHTML = events.map((event) => {
    let label = "Attendance activity";
    let details = "";
    let action = "";
    if (event.action === "attendance.recorded") {
      label = "Check-in recorded";
      details = `${event.details.studentName} · ${event.details.studentId}`;
      const stillPresent = state.attendance.some((record) =>
        record.sessionId === event.details.sessionId && record.studentId === event.details.studentId
      );
      const attendanceKey = `${event.details.sessionId}:${event.details.studentId}`;
      if (stillPresent && !correctionActions.has(attendanceKey)) {
        action = `<button class="audit-correct" type="button" data-correct-session="${escapeHtml(event.details.sessionId)}" data-correct-student="${escapeHtml(event.details.studentId)}">Correct</button>`;
        correctionActions.add(attendanceKey);
      }
    } else if (event.action === "attendance.corrected") {
      label = "Attendance corrected";
      details = `${event.details.studentName} · ${event.details.studentId} — ${event.details.reason}`;
    } else if (event.action === "report.exported") {
      label = `${String(event.details.format).toUpperCase()} report exported`;
      details = `${event.details.start} to ${event.details.end} · ${event.details.sessionsHeld} sessions · ${event.details.studentCount} students`;
    }
    const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(event.timestamp));
    return `<tr><td>${escapeHtml(when)}</td><td>${escapeHtml(label)}</td><td>${escapeHtml(event.actorName || event.actorType)}</td><td><span>${escapeHtml(details)}</span>${action}</td></tr>`;
  }).join("");
}

function renderSession() {
  window.clearInterval(state.countdownTimer);
  const session = state.session;
  byId("qr-content").hidden = !session;
  byId("qr-empty").hidden = Boolean(session);
  byId("session-create-controls").hidden = Boolean(session);
  byId("generate-session").disabled = !state.course || state.students.length === 0 || Boolean(session);
  byId("live-pill").classList.toggle("live-active", Boolean(session));
  byId("live-pill").innerHTML = `<i></i> ${session ? "LIVE · CHECK-IN OPEN" : "NO SESSION"}`;
  byId("session-state").textContent = session ? "Live now" : "Not started";
  byId("session-state").classList.toggle("state-live", Boolean(session));
  byId("session-caption").textContent = session ? "Link available to students" : "Generate a QR code to begin";
  byId("session-heading").textContent = session ? "Attendance is open" : "Start a class check-in";
  byId("session-description").textContent = session
    ? "Display this QR code for your students. You can change when this link expires."
    : "Choose how long the student link should stay open, then display its QR code.";
  if (!session) {
    byId("present-count").textContent = "0";
    byId("present-caption").textContent = "Attendance for the next session";
    return;
  }

  const checkInUrl = new URL("/check-in", window.location.origin);
  checkInUrl.searchParams.set("session", session.id);
  const qr = qrcode(0, "M");
  qr.addData(checkInUrl.toString());
  qr.make();
  const image = document.createElement("img");
  image.src = qr.createDataURL(7, 4);
  image.alt = "QR code for the active class attendance session";
  byId("qr-code").replaceChildren(image);
  byId("qr-code-label").textContent = `${state.course.code} · ${state.course.room}`;
  if (document.activeElement !== byId("extend-duration")) {
    byId("extend-duration-unit").value = "minutes";
    byId("extend-duration").max = "480";
    byId("extend-duration").value = String(Math.max(1, Math.ceil((Date.parse(session.expiresAt) - Date.now()) / 60_000)));
  }

  const expiresAt = Date.parse(session.expiresAt);
  const updateCountdown = () => {
    const remaining = Math.max(0, expiresAt - Date.now());
    if (remaining === 0) {
      refreshState().catch((error) => showToast(error.message));
      return;
    }
    const minutes = Math.floor(remaining / 60_000);
    const seconds = Math.floor(remaining % 60_000 / 1000);
    byId("qr-expires").textContent = `Link expires in ${minutes}:${String(seconds).padStart(2, "0")}`;
  };
  updateCountdown();
  state.countdownTimer = window.setInterval(updateCountdown, 1000);
  byId("update-expiry").disabled = !state.managementToken;
  byId("end-session").disabled = !state.managementToken;
}

function durationInMinutes(prefix) {
  const value = Number(byId(`${prefix}-duration`).value);
  const unit = byId(`${prefix}-duration-unit`).value;
  const minutes = unit === "hours" ? value * 60 : value;
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 480 ? minutes : null;
}

function changeDurationUnit(prefix) {
  const unit = byId(`${prefix}-duration-unit`).value;
  const input = byId(`${prefix}-duration`);
  input.min = "1";
  input.max = unit === "hours" ? "8" : "480";
  input.step = "1";
  input.value = unit === "hours" ? "1" : "10";
  input.setAttribute("aria-label", unit === "hours" ? "Duration in hours" : "Duration in minutes");
  if (prefix === "session") {
    byId("generate-session").disabled = !state.course || state.students.length === 0 || Boolean(state.session) || !durationInMinutes(prefix);
  } else {
    byId("update-expiry").disabled = !durationInMinutes(prefix) || !state.managementToken;
  }
}

async function refreshState() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const requestedCourseId = state.course?.id || sessionStorage.getItem("presence-course-id") || "";
    const result = await api(`/api/state${requestedCourseId ? `?courseId=${encodeURIComponent(requestedCourseId)}` : ""}`);
    const changed = !state.loaded ||
      JSON.stringify(result.courses) !== JSON.stringify(state.courses) ||
      JSON.stringify(result.course) !== JSON.stringify(state.course) ||
      JSON.stringify(result.students) !== JSON.stringify(state.students) ||
      JSON.stringify(result.session) !== JSON.stringify(state.session) ||
      JSON.stringify(result.attendance) !== JSON.stringify(state.attendance) ||
      JSON.stringify(result.audit) !== JSON.stringify(state.audit);
    const previousSession = state.session;
    state.lecturer = result.lecturer;
    state.courses = result.courses;
    state.course = result.course;
    state.students = result.students;
    state.session = result.session;
    state.attendance = result.attendance;
    state.audit = result.audit || [];
    if (state.course) sessionStorage.setItem("presence-course-id", state.course.id);
    byId("lecturer-name").textContent = state.lecturer.name;
    byId("lecturer-avatar").textContent = initials(state.lecturer.name);
    if (previousSession && previousSession.id !== state.session?.id) {
      sessionStorage.removeItem(`presence-manager:${previousSession.id}`);
    }
    state.managementToken = state.session
      ? sessionStorage.getItem(`presence-manager:${state.session.id}`) || ""
      : "";
    if (!changed) return;
    state.loaded = true;
    renderCourse();
    renderSession();
    renderRoster();
    renderAudit();
  } finally {
    state.refreshing = false;
  }
}

function openCourseDialog() {
  byId("course-error").textContent = "";
  const course = state.editingCourse ? null : state.course;
  byId("course-dialog-title").textContent = course ? "Edit class details" : "Create a class";
  byId("course-name-input").value = course?.name || "";
  byId("course-code-input").value = course?.code || "";
  byId("course-lecturer-input").value = course?.lecturer || state.lecturer?.name || "";
  byId("course-room-input").value = course?.room || "";
  byId("course-latitude-input").value = course?.latitude ?? "";
  byId("course-longitude-input").value = course?.longitude ?? "";
  byId("course-radius-input").value = course?.radiusMeters || "100";
  byId("course-dialog").showModal();
}

function useCurrentLocation() {
  const button = byId("use-current-location");
  if (!navigator.geolocation) {
    byId("course-error").textContent = "Location services are unavailable in this browser. Enter the room coordinates manually.";
    return;
  }
  button.disabled = true;
  button.textContent = "Getting location…";
  navigator.geolocation.getCurrentPosition((position) => {
    byId("course-latitude-input").value = position.coords.latitude.toFixed(7);
    byId("course-longitude-input").value = position.coords.longitude.toFixed(7);
    byId("course-error").textContent = "";
    button.disabled = false;
    button.textContent = "Use current location";
  }, (error) => {
    const messages = {
      1: "Location permission was denied. Allow location access or enter coordinates manually.",
      2: "Your location could not be determined. Try again or enter coordinates manually.",
      3: "The location request timed out. Try again."
    };
    byId("course-error").textContent = messages[error.code] || "Could not read the current location.";
    button.disabled = false;
    button.textContent = "Use current location";
  }, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 });
}

async function saveCourse(event) {
  event.preventDefault();
  byId("course-error").textContent = "";
  const course = {
    name: byId("course-name-input").value.trim(),
    code: byId("course-code-input").value.trim(),
    lecturer: byId("course-lecturer-input").value.trim(),
    room: byId("course-room-input").value.trim(),
    latitude: Number(byId("course-latitude-input").value),
    longitude: Number(byId("course-longitude-input").value),
    radiusMeters: Number(byId("course-radius-input").value)
  };
  try {
    const result = state.course && !state.editingCourse
      ? await api(`/api/courses/${encodeURIComponent(state.course.id)}`, { method: "PUT", body: JSON.stringify(course) })
      : await api("/api/courses", { method: "POST", body: JSON.stringify(course) });
    if (result.course) {
      state.course = result.course;
      sessionStorage.setItem("presence-course-id", result.course.id);
    }
    state.editingCourse = false;
    byId("course-dialog").close();
    await refreshState();
    showToast("Class details saved.");
  } catch (error) {
    byId("course-error").textContent = error.message;
  }
}

async function generateSession() {
  const durationMinutes = durationInMinutes("session");
  if (!durationMinutes) {
    showToast("Choose a link expiry between 1 and 480 minutes.");
    return;
  }
  try {
    const result = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ courseId: state.course.id, durationMinutes })
    });
    state.session = result.session;
    state.managementToken = result.managementToken;
    try {
      sessionStorage.setItem(`presence-manager:${state.session.id}`, state.managementToken);
    } catch {
      showToast("Keep this lecturer tab open to manage the session expiry.");
    }
    renderSession();
    renderRoster();
    showToast("Attendance link created. Share the QR code with your class.");
  } catch (error) {
    showToast(error.message);
  }
}

async function updateExpiry() {
  if (!state.session) return;
  const durationMinutes = durationInMinutes("extend");
  if (!durationMinutes) {
    showToast("Choose an expiry between 1 and 480 minutes from now.");
    return;
  }
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(state.session.id)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${state.managementToken}` },
      body: JSON.stringify({ durationMinutes })
    });
    state.session = result.session;
    renderSession();
    showToast("Attendance link expiry updated.");
  } catch (error) {
    showToast(error.message);
  }
}

async function endSession() {
  if (!state.session) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(state.session.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${state.managementToken}` }
    });
    await refreshState();
    showToast("Attendance link closed.");
  } catch (error) {
    showToast(error.message);
  }
}

async function addStudent(event) {
  event.preventDefault();
  byId("dialog-error").textContent = "";
  try {
    const student = {
      id: byId("new-student-id").value.trim(),
      name: byId("new-student-name").value.trim(),
      program: byId("new-student-program").value.trim() || "Programme not provided"
    };
    await api(`/api/courses/${encodeURIComponent(state.course.id)}/students`, { method: "POST", body: JSON.stringify(student) });
    byId("add-dialog").close();
    byId("add-student-form").reset();
    await refreshState();
    showToast(`${student.name} added to the class roster.`);
  } catch (error) {
    byId("dialog-error").textContent = error.message;
  }
}

async function removeStudent(id) {
  const student = state.students.find((entry) => entry.id === id);
  if (!student || !window.confirm(`Remove ${student.name} from this class roster?`)) return;
  try {
    await api(`/api/courses/${encodeURIComponent(state.course.id)}/students/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refreshState();
    showToast("Student removed from the roster.");
  } catch (error) {
    showToast(error.message);
  }
}

function updateReportActions() {
  const start = byId("report-start").value;
  const end = byId("report-end").value;
  const valid = Boolean(state.course && start && end && start <= end);
  byId("preview-report").disabled = !valid;
  byId("export-excel").disabled = !valid;
  byId("export-pdf").disabled = !valid;
}

function reportDatesChanged() {
  updateReportActions();
  byId("report-error").textContent = "";
  byId("report-table-wrap").hidden = true;
  byId("report-session-count").textContent = "Calculate to update report";
}

async function previewReport() {
  byId("report-error").textContent = "";
  updateReportActions();
  if (byId("preview-report").disabled) return;
  const params = new URLSearchParams({ start: byId("report-start").value, end: byId("report-end").value });
  try {
    const report = await api(`/api/courses/${encodeURIComponent(state.course.id)}/report?${params}`);
    byId("report-session-count").textContent = `${report.sessionsHeld} ${report.sessionsHeld === 1 ? "session" : "sessions"} held`;
    byId("report-body").innerHTML = report.rows.map((row) =>
      `<tr><td>${escapeHtml(row.name)}<small>${escapeHtml(row.program)}</small></td><td class="reg-number">${escapeHtml(row.id)}</td><td>${row.sessionsAttended}</td><td>${row.sessionsHeld}</td><td><strong>${row.attendancePercentage.toFixed(2)}%</strong></td></tr>`
    ).join("");
    byId("report-table-wrap").hidden = report.rows.length === 0;
    if (report.rows.length === 0) byId("report-session-count").textContent += " · no student records";
  } catch (error) {
    byId("report-error").textContent = error.message;
  }
}

async function downloadReport(format) {
  updateReportActions();
  if (byId("export-excel").disabled) return;
  const params = new URLSearchParams({ start: byId("report-start").value, end: byId("report-end").value });
  const url = `/api/courses/${encodeURIComponent(state.course.id)}/reports.${format}?${params}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      let error = "Could not download the attendance report.";
      try { error = (await response.json()).error || error; } catch {}
      throw new Error(error);
    }
    const blob = await response.blob();
    const anchor = document.createElement("a");
    const objectUrl = URL.createObjectURL(blob);
    anchor.href = objectUrl;
    anchor.download = `${state.course.code.replace(/[^A-Za-z0-9_-]+/g, "_")}-attendance-${byId("report-start").value}-${byId("report-end").value}.${format}`;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
    refreshState().catch((error) => showToast(`Report downloaded, but the audit trail could not be refreshed: ${error.message}`));
  } catch (error) {
    byId("report-error").textContent = error.message;
  }
}

byId("edit-course").addEventListener("click", () => { state.editingCourse = false; openCourseDialog(); });
byId("create-course").addEventListener("click", () => { state.editingCourse = true; openCourseDialog(); });
byId("empty-setup").addEventListener("click", openCourseDialog);
byId("course-form").addEventListener("submit", saveCourse);
byId("close-course-dialog").addEventListener("click", () => byId("course-dialog").close());
byId("cancel-course").addEventListener("click", () => byId("course-dialog").close());
byId("use-current-location").addEventListener("click", useCurrentLocation);
byId("generate-session").addEventListener("click", generateSession);
byId("update-expiry").addEventListener("click", updateExpiry);
byId("end-session").addEventListener("click", endSession);
byId("copy-link").addEventListener("click", () => {
  if (!state.session) return;
  const link = new URL("/check-in", window.location.origin);
  link.searchParams.set("session", state.session.id);
  if (!navigator.clipboard?.writeText) {
    showToast("Clipboard access is unavailable in this browser.");
    return;
  }
  navigator.clipboard.writeText(link.toString())
    .then(() => showToast("Student check-in link copied."))
    .catch(() => showToast("Clipboard access is unavailable in this browser."));
});
byId("session-duration").addEventListener("input", () => {
  byId("generate-session").disabled = !state.course || state.students.length === 0 ||
    !durationInMinutes("session") || Boolean(state.session);
});
byId("extend-duration").addEventListener("input", () => {
  byId("update-expiry").disabled = !durationInMinutes("extend") || !state.managementToken;
});
byId("session-duration-unit").addEventListener("change", () => changeDurationUnit("session"));
byId("extend-duration-unit").addEventListener("change", () => changeDurationUnit("extend"));
byId("roster-search").addEventListener("input", renderRoster);
byId("refresh-roster").addEventListener("click", () => refreshState().catch((error) => showToast(error.message)));
byId("roster-body").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove]");
  if (button) removeStudent(button.dataset.remove);
});
byId("audit-body").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-correct-session]");
  if (!button) return;
  const reason = window.prompt("Enter the reason for correcting this attendance record (at least 8 characters):");
  if (reason === null) return;
  try {
    await api(`/api/courses/${encodeURIComponent(state.course.id)}/attendance/${encodeURIComponent(button.dataset.correctSession)}/${encodeURIComponent(button.dataset.correctStudent)}`, {
      method: "DELETE",
      body: JSON.stringify({ reason })
    });
    await refreshState();
    showToast("Attendance corrected and recorded in the audit trail.");
  } catch (error) {
    showToast(error.message);
  }
});
byId("add-student").addEventListener("click", () => byId("add-dialog").showModal());
byId("close-add-dialog").addEventListener("click", () => byId("add-dialog").close());
byId("cancel-add").addEventListener("click", () => byId("add-dialog").close());
byId("add-student-form").addEventListener("submit", addStudent);
byId("course-select").addEventListener("change", async (event) => {
  state.course = state.courses.find((course) => course.id === event.target.value) || null;
  if (state.course) sessionStorage.setItem("presence-course-id", state.course.id);
  byId("report-table-wrap").hidden = true;
  byId("report-session-count").textContent = "Calculate to update report";
  byId("report-error").textContent = "";
  state.loaded = false;
  await refreshState();
});
byId("report-start").addEventListener("change", reportDatesChanged);
byId("report-end").addEventListener("change", reportDatesChanged);
byId("preview-report").addEventListener("click", previewReport);
byId("export-excel").addEventListener("click", () => downloadReport("xlsx"));
byId("export-pdf").addEventListener("click", () => downloadReport("pdf"));
byId("refresh-audit").addEventListener("click", () => refreshState().catch((error) => showToast(error.message)));
async function showLecturerDashboard() {
  byId("auth-view").hidden = true;
  byId("lecturer-view").hidden = false;
  byId("lecturer-avatar").hidden = false;
  byId("lecturer-name").hidden = false;
  byId("logout-button").hidden = false;
  await refreshState();
  window.clearInterval(state.refreshTimer);
  state.refreshTimer = window.setInterval(() => {
    refreshState().catch((error) => showToast(error.message));
  }, 5000);
}

async function showAuthentication() {
  byId("lecturer-view").hidden = true;
  byId("lecturer-avatar").hidden = true;
  byId("lecturer-name").hidden = true;
  byId("logout-button").hidden = true;
  byId("auth-view").hidden = false;
  const status = await api("/api/auth/status");
  const params = new URLSearchParams(window.location.search);
  const signup = params.get("auth") === "signup" ||
    window.location.pathname === "/lecturer/signup" ||
    window.location.pathname === "/lecturer/activate";
  const invitation = params.get("invite") || "";
  byId("auth-kicker").textContent = signup ? "ACCOUNT ACTIVATION" : "LECTURER ACCESS";
  byId("auth-title").textContent = signup ? "Activate lecturer account" : "Welcome back";
  byId("auth-description").textContent = signup
    ? "Use your one-time invitation from the site administrator to activate your lecturer account."
    : "Sign in to manage your classes and attendance reports.";
  byId("auth-name-wrap").hidden = !signup;
  byId("auth-name").required = signup;
  byId("auth-invite-wrap").hidden = !signup;
  byId("auth-invite").required = signup;
  byId("auth-invite").value = invitation;
  byId("auth-confirm-wrap").hidden = !signup;
  byId("auth-confirm").required = signup;
  byId("auth-password").autocomplete = signup ? "new-password" : "current-password";
  byId("auth-confirm").autocomplete = signup ? "new-password" : "off";
  byId("auth-submit").disabled = signup && !status.hasInvitation;
  byId("auth-submit").textContent = signup ? "Activate account" : "Sign in";
  byId("auth-switch").innerHTML = signup
    ? 'Already activated? <a href="/lecturer/login">Sign in</a>'
    : 'First time here? <a href="/lecturer/activate">Activate with an invitation</a>';
  byId("auth-recovery-help").hidden = signup;
  byId("auth-admin-link").hidden = signup;
  byId("auth-error").textContent = signup && !status.hasInvitation
    ? "A site-owner invitation is required before lecturer sign-up."
    : "";
}

byId("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  byId("auth-error").textContent = "";
  const password = byId("auth-password").value;
  const signup = byId("auth-name").required;
  if (signup && password !== byId("auth-confirm").value) {
    byId("auth-error").textContent = "The passwords do not match.";
    return;
  }
  try {
    await api(signup ? "/api/auth/signup" : "/api/auth/login", {
      method: "POST",
      body: JSON.stringify(signup ? {
        name: byId("auth-name").value.trim(),
        email: byId("auth-email").value.trim(),
        password,
        invitationCode: byId("auth-invite").value.trim()
      } : {
        email: byId("auth-email").value.trim(),
        password
      })
    });
    byId("auth-password").value = "";
    byId("auth-confirm").value = "";
    await showLecturerDashboard();
  } catch (error) {
    byId("auth-error").textContent = error.message;
  }
});

byId("logout-button").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
    window.clearInterval(state.refreshTimer);
    state.refreshTimer = null;
    state.session = null;
    state.managementToken = "";
    await showAuthentication();
  } catch (error) {
    showToast(error.message);
  }
});

async function start() {
  try {
    const status = await api("/api/auth/status");
    if (status.authenticated) await showLecturerDashboard();
    else await showAuthentication();
  } catch (error) {
    showToast(`Could not load lecturer access: ${error.message}`);
  }
}

start();
