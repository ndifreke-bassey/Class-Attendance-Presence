"use strict";

const byId = (id) => document.getElementById(id);
const sessionId = new URLSearchParams(window.location.search).get("session");
const checkInMachine = window.PresenceCheckInMachine;
const state = {
  phase: "loading",
  course: null,
  session: null,
  student: null,
  location: null,
  locationRetry: false,
  selfieCaptured: false,
  cameraStream: null,
  cameraReturnPhase: "location-confirmed",
  lookupAttempt: 0,
  locationAttempt: 0,
  lookupTimer: null,
  expiryTimer: null,
  statusTimer: null,
  toastTimer: null,
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

function distanceMeters(lat1, lon1, lat2, lon2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const deltaLat = radians(lat2 - lat1);
  const deltaLon = radians(lon2 - lon1);
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(deltaLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function setPhase(nextPhase) {
  state.phase = checkInMachine.transition(state.phase, nextPhase);
  renderPhase();
}

function renderPhase() {
  const phase = state.phase;
  const hasStudent = [
    "student-found", "checking-location", "location-confirmed", "opening-camera",
    "camera-ready", "photo-captured", "submitting", "complete"
  ].includes(phase);
  const hasLocation = [
    "location-confirmed", "opening-camera", "camera-ready", "photo-captured",
    "submitting", "complete"
  ].includes(phase);
  const terminal = phase === "expired" || phase === "complete";
  const submitting = phase === "submitting";

  byId("registration-number").disabled = terminal || submitting;
  byId("student-lookup-form").setAttribute("aria-busy", String(phase === "looking-up"));
  const lookupButton = byId("student-lookup-form").querySelector("button");
  lookupButton.disabled = terminal || submitting || phase === "looking-up";
  lookupButton.textContent = phase === "looking-up" ? "Finding details…" : "Find my details";
  byId("student-profile").hidden = !hasStudent;
  byId("location-step").hidden = !hasStudent;
  byId("location-action").hidden = !hasStudent;
  byId("verify-location").disabled = phase !== "student-found";
  byId("location-action").setAttribute("aria-busy", String(phase === "checking-location"));
  if (phase === "checking-location") byId("verify-location").textContent = "Checking…";
  else if (phase === "location-confirmed") byId("verify-location").textContent = "Location confirmed";
  else if (phase === "student-found") {
    byId("verify-location").textContent = state.locationRetry ? "Try again" : "Verify location";
  }

  byId("face-step").hidden = !hasLocation;
  byId("face-warning").hidden = !hasLocation;
  byId("face-area").hidden = !hasLocation;
  byId("face-area").setAttribute("aria-busy", String(phase === "opening-camera"));
  byId("student-camera-stage").hidden = phase !== "camera-ready";
  byId("open-student-camera").hidden = phase === "opening-camera" || phase === "camera-ready";
  byId("open-student-camera").disabled = !hasLocation || terminal;
  byId("captured-photo").hidden = !["photo-captured", "submitting"].includes(phase);
  byId("submit-attendance").disabled = phase !== "photo-captured";
  byId("submit-attendance").textContent = phase === "submitting" ? "Submitting…" : "Submit attendance";
}

function setExpired(message) {
  if (state.phase === "expired" || state.phase === "complete") return;
  setPhase("expired");
  state.lookupAttempt += 1;
  state.locationAttempt += 1;
  window.clearTimeout(state.lookupTimer);
  window.clearInterval(state.expiryTimer);
  window.clearInterval(state.statusTimer);
  state.selfieCaptured = false;
  state.student = null;
  state.location = null;
  state.locationRetry = false;
  byId("captured-photo").removeAttribute("src");
  stopStudentCamera();
  byId("link-status").classList.add("link-expired");
  byId("link-status").innerHTML = "<i></i> Link expired";
  byId("student-countdown").textContent = "This class check-in has closed.";
  byId("student-error").textContent = message;
}

function renderExpiry() {
  window.clearInterval(state.expiryTimer);
  const update = () => {
    const remaining = Date.parse(state.session.expiresAt) - Date.now();
    if (state.phase === "expired" || state.phase === "complete") return;
    if (remaining <= 0) {
      window.clearInterval(state.expiryTimer);
      checkSession().catch(() => setExpired("This check-in link has expired. Ask your lecturer for a new QR code."));
      return;
    }
    const minutes = Math.floor(remaining / 60_000);
    const seconds = Math.floor(remaining % 60_000 / 1000);
    byId("student-countdown").hidden = false;
    byId("student-countdown").textContent = `This link expires in ${minutes}:${String(seconds).padStart(2, "0")}.`;
  };
  update();
  state.expiryTimer = window.setInterval(update, 1000);
}

async function checkSession() {
  if (state.phase === "expired" || state.phase === "complete") return;
  const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (state.phase === "expired" || state.phase === "complete") return;
  state.session = result.session;
  state.course = result.course;
  if (state.phase === "loading") setPhase("ready");
  byId("student-course-summary").textContent = `${result.course.name} · ${result.course.code} · ${result.course.room}`;
  byId("link-status").classList.remove("link-expired");
  byId("link-status").innerHTML = "<i></i> Active class link";
  renderExpiry();
}

async function lookupStudent(event) {
  event.preventDefault();
  if (["expired", "complete", "submitting"].includes(state.phase)) return;
  const registration = byId("registration-number").value.trim();
  byId("student-error").textContent = "";
  resetVerification();
  if (!/^[A-Za-z0-9-]{4,16}$/.test(registration)) {
    byId("student-error").textContent = "Enter a valid registration number.";
    return;
  }
  const attempt = ++state.lookupAttempt;
  setPhase("looking-up");
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/students/${encodeURIComponent(registration)}`);
    if (attempt !== state.lookupAttempt || state.phase !== "looking-up") return;
    state.student = result.student;
    byId("student-profile").innerHTML = `<span class="student-avatar">${escapeHtml(initials(result.student.name))}</span><span class="student-profile-copy"><strong>${escapeHtml(result.student.name)}</strong><small>${escapeHtml(result.student.id)} · ${escapeHtml(result.student.program)}</small></span><span class="profile-check">✓</span>`;
    setPhase("student-found");
  } catch (error) {
    if (attempt !== state.lookupAttempt || state.phase !== "looking-up") return;
    if (error.message.includes("expired")) setExpired(error.message);
    else {
      setPhase("ready");
      byId("student-error").textContent = error.message;
    }
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function resetVerification() {
  state.lookupAttempt += 1;
  state.locationAttempt += 1;
  state.student = null;
  state.location = null;
  state.locationRetry = false;
  state.selfieCaptured = false;
  state.cameraReturnPhase = "location-confirmed";
  stopStudentCamera();
  byId("captured-photo").removeAttribute("src");
  byId("location-result").classList.remove("verification-ok");
  byId("location-result").textContent = "Location verification is required to continue.";
  byId("face-result").classList.remove("verification-ok");
  byId("face-result").textContent = "Camera photo required to continue.";
  byId("open-student-camera").textContent = "Open camera";
  if (state.phase !== "ready") setPhase("ready");
  else renderPhase();
}

function verifyStudentLocation() {
  if (state.phase !== "student-found") return;
  const button = byId("verify-location");
  const result = byId("location-result");
  if (!navigator.geolocation) {
    result.textContent = "Location services are not available in this browser.";
    return;
  }
  const attempt = ++state.locationAttempt;
  setPhase("checking-location");
  button.disabled = true;
  button.textContent = "Checking…";
  result.textContent = "Waiting for location permission…";
  navigator.geolocation.getCurrentPosition((position) => {
    if (attempt !== state.locationAttempt || state.phase !== "checking-location") return;
    const accuracy = position.coords.accuracy;
    const distance = distanceMeters(
      position.coords.latitude, position.coords.longitude,
      state.course.latitude, state.course.longitude
    );
    if (accuracy > 150) {
      result.textContent = `Location accuracy is about ${Math.round(accuracy)} m. Try again with a clearer GPS signal.`;
      state.locationRetry = true;
      setPhase("student-found");
      return;
    }
    if (distance > state.course.radiusMeters) {
      result.textContent = `You are about ${Math.round(distance)} m from the class location. Move closer and try again.`;
      state.locationRetry = true;
      setPhase("student-found");
      return;
    }
    state.location = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy
    };
    state.locationRetry = false;
    result.textContent = `Location confirmed near the class (${Math.round(accuracy)} m accuracy).`;
    result.classList.add("verification-ok");
    setPhase("location-confirmed");
  }, (error) => {
    if (attempt !== state.locationAttempt || state.phase !== "checking-location") return;
    const messages = {
      1: "Location permission was denied. Allow location access in browser settings.",
      2: "Your location could not be determined. Check device location services.",
      3: "The location request timed out. Try again."
    };
    result.textContent = messages[error.code] || "Location verification failed.";
    state.locationRetry = true;
    setPhase("student-found");
  }, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 });
}

async function openStudentCamera() {
  if (!["location-confirmed", "photo-captured"].includes(state.phase)) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("Camera access requires HTTPS or localhost in a supported browser.");
    return;
  }
  state.cameraReturnPhase = state.phase;
  byId("face-result").textContent = "Opening camera…";
  setPhase("opening-camera");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user" } });
    if (state.phase !== "opening-camera") {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    state.cameraStream = stream;
    byId("student-video").srcObject = state.cameraStream;
    byId("face-result").textContent = "Camera ready. Position yourself and capture a photo.";
    setPhase("camera-ready");
  } catch (error) {
    if (state.phase === "opening-camera") {
      setPhase(state.cameraReturnPhase);
      byId("face-result").textContent = state.cameraReturnPhase === "photo-captured"
        ? "Photo captured. Face identity was not compared."
        : "Camera photo required to continue.";
    }
    showToast(error.name === "NotAllowedError"
      ? "Camera permission was denied. Allow camera access to take a check-in photo."
      : "Could not open the camera. Check that it is available and try again.");
  }
}

function stopStudentCamera() {
  if (state.cameraStream) state.cameraStream.getTracks().forEach((track) => track.stop());
  state.cameraStream = null;
  byId("student-video").srcObject = null;
  renderPhase();
}

function captureStudentPhoto() {
  if (state.phase !== "camera-ready") return;
  const video = byId("student-video");
  if (!video.videoWidth || !video.videoHeight) {
    showToast("Wait for the camera preview to load, then try again.");
    return;
  }
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 640 / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) {
    showToast("This browser cannot capture the camera image.");
    return;
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  byId("captured-photo").src = canvas.toDataURL("image/jpeg", 0.75);
  byId("face-result").textContent = "Photo captured. Face identity was not compared.";
  byId("face-result").classList.add("verification-ok");
  state.selfieCaptured = true;
  setPhase("photo-captured");
  stopStudentCamera();
  byId("open-student-camera").textContent = "Retake photo";
}

async function submitStudentAttendance() {
  if (state.phase !== "photo-captured" || !state.student || !state.location || !state.selfieCaptured) return;
  setPhase("submitting");
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/attendance`, {
      method: "POST",
      body: JSON.stringify({
        studentId: state.student.id,
        ...state.location,
        selfieCaptured: state.selfieCaptured
      })
    });
    byId("success-message").textContent = `${result.record.studentName}, your attendance for ${state.course.name} has been recorded.`;
    setPhase("complete");
    window.clearInterval(state.expiryTimer);
    window.clearInterval(state.statusTimer);
    byId("success-dialog").showModal();
  } catch (error) {
    if (error.message.includes("expired")) setExpired(error.message);
    else if (state.phase === "submitting") {
      setPhase("photo-captured");
      byId("student-error").textContent = error.message;
    }
  }
}

byId("student-lookup-form").addEventListener("submit", lookupStudent);
byId("registration-number").addEventListener("input", () => {
  if (["expired", "complete", "submitting"].includes(state.phase)) return;
  window.clearTimeout(state.lookupTimer);
  const value = byId("registration-number").value.trim();
  if (value !== state.registrationValue) {
    state.registrationValue = value;
    if (!["loading", "ready", "expired", "complete"].includes(state.phase)) resetVerification();
  }
  if (/^[A-Za-z0-9-]{4,16}$/.test(value)) {
    state.lookupTimer = window.setTimeout(() => {
      if (byId("registration-number").value.trim() === value) {
        lookupStudent({ preventDefault() {} });
      }
    }, 250);
  }
});
byId("verify-location").addEventListener("click", verifyStudentLocation);
byId("open-student-camera").addEventListener("click", openStudentCamera);
byId("capture-student-photo").addEventListener("click", captureStudentPhoto);
byId("cancel-student-camera").addEventListener("click", () => {
  if (state.phase !== "camera-ready") return;
  stopStudentCamera();
  setPhase(state.cameraReturnPhase);
  byId("face-result").textContent = state.cameraReturnPhase === "photo-captured"
    ? "Photo captured. Face identity was not compared."
    : "Camera photo required to continue.";
});
byId("submit-attendance").addEventListener("click", submitStudentAttendance);
byId("success-done").addEventListener("click", () => byId("success-dialog").close());
byId("success-dialog").addEventListener("close", stopStudentCamera);
byId("consent-dialog").addEventListener("cancel", (event) => event.preventDefault());
byId("consent-checkbox").addEventListener("change", (event) => {
  byId("consent-submit").disabled = !event.currentTarget.checked;
  byId("consent-required").textContent = "";
});
byId("consent-submit").addEventListener("click", () => {
  if (!byId("consent-checkbox").checked) {
    byId("consent-required").textContent = "Accept the terms to continue to this check-in.";
    return;
  }
  byId("consent-dialog").close();
  start();
});

async function start() {
  if (!sessionId) {
    setExpired("This check-in page can only be opened from a lecturer-issued QR code or link.");
    return;
  }
  try {
    await checkSession();
    state.statusTimer = window.setInterval(() => {
      checkSession().catch((error) => setExpired(error.message));
    }, 5000);
  } catch (error) {
    setExpired(error.message);
  }
}

byId("consent-dialog").showModal();
