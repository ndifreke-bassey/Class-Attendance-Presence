"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const root = path.resolve(__dirname, "..");
const ownerPassword = "integration-test-owner-password";
let dataDirectory;
let serverProcess;
let baseUrl;
let lecturerCookie;
let adminCookie;

async function reservePort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function request(route, { method = "GET", cookie, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  return { response, payload };
}

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Test server exited during startup: ${serverProcess.output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Test server did not start: ${serverProcess.output}`);
}

before(async () => {
  dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "presence-integration-"));
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      PRESENCE_BIND_HOST: "127.0.0.1",
      PRESENCE_DATA_DIR: dataDirectory,
      PRESENCE_ADMIN_PASSWORD: ownerPassword
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  serverProcess.output = "";
  serverProcess.stdout.setEncoding("utf8").on("data", (chunk) => { serverProcess.output += chunk; });
  serverProcess.stderr.setEncoding("utf8").on("data", (chunk) => { serverProcess.output += chunk; });
  await waitForServer();
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    const exited = once(serverProcess, "exit");
    serverProcess.kill("SIGTERM");
    await exited;
  }
  if (dataDirectory) await fs.rm(dataDirectory, { recursive: true, force: true });
});

test("owner, lecturer, and student attendance workflows enforce access and attendance rules", async (t) => {
  await t.test("owner access is protected and invitations are single-use", async () => {
    const denied = await request("/api/admin/lecturers");
    assert.equal(denied.response.status, 401);

    const login = await request("/api/admin/login", {
      method: "POST",
      body: { password: ownerPassword }
    });
    assert.equal(login.response.status, 200);
    adminCookie = login.response.headers.getSetCookie()
      .find((cookie) => cookie.startsWith("presence_admin="))
      .split(";")[0];

    const invitation = await request("/api/admin/invitations", {
      method: "POST",
      cookie: adminCookie,
      body: {}
    });
    assert.equal(invitation.response.status, 201);

    const signup = await request("/api/auth/signup", {
      method: "POST",
      body: {
        email: "lecturer@example.edu",
        name: "Test Lecturer",
        password: "a-secure-test-password",
        invitationCode: invitation.payload.code
      }
    });
    assert.equal(signup.response.status, 201);
    lecturerCookie = signup.response.headers.getSetCookie()
      .find((cookie) => cookie.startsWith("presence_lecturer="))
      .split(";")[0];
    assert.ok(lecturerCookie.length > "presence_lecturer=".length);
    const profile = await request("/api/auth/me", { cookie: lecturerCookie });
    assert.equal(profile.response.status, 200, JSON.stringify(profile.payload));

    const replay = await request("/api/auth/signup", {
      method: "POST",
      body: {
        email: "another-lecturer@example.edu",
        name: "Another Lecturer",
        password: "another-secure-password",
        invitationCode: invitation.payload.code
      }
    });
    assert.equal(replay.response.status, 403);

    const lecturerDenied = await request("/api/admin/lecturers", { cookie: lecturerCookie });
    assert.equal(lecturerDenied.response.status, 401);

    for (let index = 0; index < 10; index += 1) {
      await request("/api/auth/login", {
        method: "POST",
        body: { email: "lecturer@example.edu", password: "wrong-password" }
      });
    }
    const blocked = await request("/api/auth/login", {
      method: "POST",
      body: { email: "lecturer@example.edu", password: "wrong-password" }
    });
    assert.equal(blocked.response.status, 429);
  });

  await t.test("roster, location, duplicate, session, and report rules are enforced", async () => {
    const noSession = await request("/api/sessions", {
      method: "POST",
      body: { courseId: "unknown", durationMinutes: 10 }
    });
    assert.equal(noSession.response.status, 401);

    const createdCourse = await request("/api/courses", {
      method: "POST",
      cookie: lecturerCookie,
      body: {
        name: "Integration Testing",
        code: "TEST101",
        lecturer: "Test Lecturer",
        room: "Test Hall",
        latitude: 5.6037,
        longitude: -0.187,
        radiusMeters: 100
      }
    });
    assert.equal(createdCourse.response.status, 201);
    const courseId = createdCourse.payload.course.id;

    const createdStudent = await request(`/api/courses/${courseId}/students`, {
      method: "POST",
      cookie: lecturerCookie,
      body: { id: "TEST-0001", name: "Test Student", program: "Computer Science" }
    });
    assert.equal(createdStudent.response.status, 201);

    const sessionResult = await request("/api/sessions", {
      method: "POST",
      cookie: lecturerCookie,
      body: { courseId, durationMinutes: 10 }
    });
    assert.equal(sessionResult.response.status, 201);
    const { id: sessionId } = sessionResult.payload.session;
    const managementToken = sessionResult.payload.managementToken;
    assert.equal(Object.hasOwn(sessionResult.payload.session, "manageTokenHash"), false);

    const checkInPage = await request(`/check-in?session=${encodeURIComponent(sessionId)}`);
    assert.equal(checkInPage.response.status, 200);
    assert.match(checkInPage.payload, /src="\/check-in-machine\.js"/);
    assert.match(checkInPage.payload, /src="\/check-in\.js"/);
    assert.match(checkInPage.payload, /id="consent-dialog"/);
    assert.match(checkInPage.payload, /id="consent-checkbox" type="checkbox"/);
    assert.match(checkInPage.payload, /id="consent-submit" type="button" disabled/);
    const machineScript = await request("/check-in-machine.js");
    assert.equal(machineScript.response.status, 200);
    assert.match(machineScript.payload, /PresenceCheckInMachine/);

    const unauthorizedEdit = await request(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      body: { durationMinutes: 20 }
    });
    assert.equal(unauthorizedEdit.response.status, 401);
    const lecturerWithoutSessionToken = await request(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      cookie: lecturerCookie,
      body: { durationMinutes: 20 }
    });
    assert.equal(lecturerWithoutSessionToken.response.status, 403);

    const studentLookup = await request(`/api/sessions/${sessionId}/students/TEST-0001`);
    assert.equal(studentLookup.response.status, 200);
    assert.equal(studentLookup.payload.student.name, "Test Student");

    const inaccurateLocation = await request(`/api/sessions/${sessionId}/attendance`, {
      method: "POST",
      body: {
        studentId: "TEST-0001",
        latitude: 5.6037,
        longitude: -0.187,
        accuracy: 151,
        selfieCaptured: true
      }
    });
    assert.equal(inaccurateLocation.response.status, 400);

    const outsideVenue = await request(`/api/sessions/${sessionId}/attendance`, {
      method: "POST",
      body: {
        studentId: "TEST-0001",
        latitude: 5.61,
        longitude: -0.187,
        accuracy: 10,
        selfieCaptured: true
      }
    });
    assert.equal(outsideVenue.response.status, 403);

    const missingSelfieFlag = await request(`/api/sessions/${sessionId}/attendance`, {
      method: "POST",
      body: {
        studentId: "TEST-0001",
        latitude: 5.6037,
        longitude: -0.187,
        accuracy: 10,
        selfieCaptured: "yes"
      }
    });
    assert.equal(missingSelfieFlag.response.status, 400);

    const attendance = await request(`/api/sessions/${sessionId}/attendance`, {
      method: "POST",
      body: {
        studentId: "TEST-0001",
        latitude: 5.6037,
        longitude: -0.187,
        accuracy: 10,
        selfieCaptured: true
      }
    });
    assert.equal(attendance.response.status, 201);
    assert.equal(attendance.payload.record.faceVerification, "not-enabled-in-prototype");

    const duplicate = await request(`/api/sessions/${sessionId}/attendance`, {
      method: "POST",
      body: {
        studentId: "TEST-0001",
        latitude: 5.6037,
        longitude: -0.187,
        accuracy: 10,
        selfieCaptured: true
      }
    });
    assert.equal(duplicate.response.status, 409);

    const lecturerProfile = await request("/api/auth/me", { cookie: lecturerCookie });
    assert.equal(lecturerProfile.response.status, 200, JSON.stringify(lecturerProfile.payload));
    const audit = await request(`/api/courses/${courseId}/audit`, { cookie: lecturerCookie });
    assert.equal(audit.response.status, 200, JSON.stringify(audit.payload));
    assert.ok(Array.isArray(audit.payload.events) && audit.payload.events.length > 0);
    assert.ok(typeof audit.payload.events[0].hash === "string" && audit.payload.events[0].hash.length > 0);
    assert.ok(audit.payload.events[0].prevHash === null || typeof audit.payload.events[0].prevHash === "string");

    const report = await request(`/api/courses/${courseId}/report?start=2020-01-01&end=2099-12-31`, {
      cookie: lecturerCookie
    });
    assert.equal(report.response.status, 200, JSON.stringify(report.payload));
    assert.equal(report.payload.sessionsHeld, 1);
    assert.equal(report.payload.rows[0].attendancePercentage, 100);

    const closed = await request(`/api/sessions/${sessionId}`, {
      method: "DELETE",
      cookie: lecturerCookie,
      headers: { Authorization: `Bearer ${managementToken}` }
    });
    assert.equal(closed.response.status, 200);
    const expiredLookup = await request(`/api/sessions/${sessionId}`);
    assert.equal(expiredLookup.response.status, 410);
  });
});

async function productionStartupResult(environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: "3000",
        PRESENCE_DATA_DIR: path.join(dataDirectory, "production-guard"),
        ...environment
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

test("production startup refuses missing owner and trusted-proxy configuration", async () => {
  const missingOwner = await productionStartupResult({
    PRESENCE_ADMIN_PASSWORD: "",
    PRESENCE_TRUST_PROXY: ""
  });
  assert.notEqual(missingOwner.code, 0);
  assert.match(missingOwner.stderr, /Production requires PRESENCE_ADMIN_PASSWORD/);

  const missingProxy = await productionStartupResult({
    PRESENCE_ADMIN_PASSWORD: ownerPassword,
    PRESENCE_TRUST_PROXY: ""
  });
  assert.notEqual(missingProxy.code, 0);
  assert.match(missingProxy.stderr, /Production requires PRESENCE_TRUST_PROXY=true/);
});
