"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual
} = require("node:crypto");
const { promisify } = require("node:util");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");

const root = __dirname;
const dataDirectory = path.resolve(process.env.PRESENCE_DATA_DIR || path.join(root, "data"));
const dataFile = path.join(dataDirectory, "store.json");
const port = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === "production";
const trustedHttpsProxy = process.env.PRESENCE_TRUST_PROXY === "true";
const bindHost = process.env.PRESENCE_BIND_HOST || (production ? "127.0.0.1" : "0.0.0.0");
const MAX_BODY_BYTES = 16_384;
const AUTH_COOKIE = "presence_lecturer";
const ADMIN_COOKIE = "presence_admin";
const AUTH_MAX_AGE_SECONDS = 8 * 60 * 60;
const INVITATION_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX = 10;
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const scryptAsync = promisify(scrypt);
const lecturerSessions = new Map();
const adminSessions = new Map();
const sessionManagementTokens = new Map();
const loginFailures = new Map();
const adminLoginFailures = new Map();
const ADMIN_PASSWORD = process.env.PRESENCE_ADMIN_PASSWORD || "";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}
if (production && ADMIN_PASSWORD.length < 16) {
  throw new Error("Production requires PRESENCE_ADMIN_PASSWORD with at least 16 characters.");
}
if (production && !trustedHttpsProxy) {
  throw new Error("Production requires PRESENCE_TRUST_PROXY=true behind a trusted HTTPS reverse proxy.");
}

const emptyStore = {
  schemaVersion: 2,
  accounts: [],
  invitations: [],
  courses: [],
  students: [],
  sessions: [],
  attendance: [],
  auditLog: []
};

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalAuditEntry(entry) {
  const { hash: _hash, prevHash: _prevHash, ...payload } = entry;
  return JSON.stringify(payload, Object.keys(payload).sort());
}

function computeAuditHash(previousHash, entry) {
  return createHash("sha256").update(`${previousHash || ""}:${canonicalAuditEntry(entry)}`).digest("hex");
}

function normalizeAuditLog(entries) {
  let previousHash = "";
  return entries.map((entry, index) => {
    const safeEntry = { ...entry };
    delete safeEntry.hash;
    delete safeEntry.prevHash;
    const normalizedEntry = {
      ...safeEntry,
      sequence: index + 1,
      prevHash: previousHash || null
    };
    const currentHash = computeAuditHash(previousHash, normalizedEntry);
    previousHash = currentHash;
    return { ...normalizedEntry, hash: currentHash };
  });
}

function safeEqualHex(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function makeInvitationCode() {
  const value = randomBytes(8).toString("hex").toUpperCase();
  return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}-${value.slice(12)}`;
}

function saveStore(nextStore) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const temporaryFile = `${dataFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(nextStore, null, 2), "utf8");
  fs.renameSync(temporaryFile, dataFile);
}

function loadStore() {
  fs.mkdirSync(dataDirectory, { recursive: true });
  if (!fs.existsSync(dataFile)) {
    saveStore(emptyStore);
    return structuredClone(emptyStore);
  }
  try {
    const stored = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    if (stored.schemaVersion !== 2 ||
      !Array.isArray(stored.accounts) ||
      !Array.isArray(stored.invitations) ||
      !Array.isArray(stored.courses) ||
      !Array.isArray(stored.students) ||
      !Array.isArray(stored.sessions) ||
      !Array.isArray(stored.attendance)) {
      throw new Error("Stored data does not use the current multi-account schema.");
    }
    let migrated = false;
    if (!Array.isArray(stored.auditLog)) {
      stored.auditLog = [];
      migrated = true;
    } else {
      stored.auditLog = normalizeAuditLog(stored.auditLog);
      migrated = true;
    }
    stored.attendance.forEach((record) => {
      if (!record.id) {
        record.id = randomBytes(16).toString("hex");
        migrated = true;
      }
    });
    if (migrated) saveStore(stored);
    return stored;
  } catch (error) {
    throw new Error(`Could not load attendance data at ${dataFile}: ${error.message}`);
  }
}

let store = loadStore();
const legacyInitialInvitations = store.invitations.filter((invite) => invite.purpose === "initial");
if (legacyInitialInvitations.length > 0) {
  store.invitations = store.invitations.filter((invite) => invite.purpose !== "initial");
  saveStore(store);
  console.log("Removed unused bootstrap invitations; new lecturer invitations are owner-managed.");
}

function jsonResponse(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function addAuditEvent({ courseId = null, action, actorType, actorId, actorName, targetId = null, details = {} }) {
  const previousHash = store.auditLog.length > 0 ? store.auditLog[store.auditLog.length - 1].hash : "";
  const entry = {
    id: randomBytes(16).toString("hex"),
    sequence: store.auditLog.length + 1,
    timestamp: new Date().toISOString(),
    courseId,
    action,
    actorType,
    actorId,
    actorName,
    targetId,
    details,
    prevHash: previousHash || null
  };
  entry.hash = computeAuditHash(previousHash, entry);
  store.auditLog.push(entry);
}

function lecturerAuditEvent(account, courseId, action, targetId, details) {
  addAuditEvent({
    courseId,
    action,
    actorType: "lecturer",
    actorId: account.id,
    actorName: account.name,
    targetId,
    details
  });
}

function courseAuditTrail(courseId, limit = 50) {
  return store.auditLog
    .filter((event) => event.courseId === courseId)
    .slice(-limit)
    .reverse();
}

function getCookie(request, name) {
  const prefix = `${name}=`;
  const value = (request.headers.cookie || "").split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(prefix));
  return value ? value.slice(prefix.length) : "";
}

function clientAddress(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (trustedHttpsProxy && typeof forwarded === "string") {
    const address = forwarded.split(",")[0].trim();
    if (address) return address;
  }
  return request.socket.remoteAddress || "unknown";
}

function rateLimitState(map, address) {
  const now = Date.now();
  let state = map.get(address);
  if (!state || state.resetAt <= now) {
    state = { count: 0, resetAt: now + LOGIN_RATE_LIMIT_WINDOW_MS };
    map.set(address, state);
  }
  return state;
}

function applyRateLimit(map, address) {
  const state = rateLimitState(map, address);
  state.count += 1;
  if (state.count > LOGIN_RATE_LIMIT_MAX) {
    return { blocked: true, retryAfterMs: Math.max(0, state.resetAt - Date.now()) };
  }
  return { blocked: false, retryAfterMs: Math.max(0, state.resetAt - Date.now()) };
}

function lecturerAccount(request) {
  const token = getCookie(request, AUTH_COOKIE);
  const session = lecturerSessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > AUTH_MAX_AGE_SECONDS * 1000) {
    lecturerSessions.delete(token);
    return null;
  }
  const account = store.accounts.find((entry) => entry.id === session.accountId);
  return account && !account.disabledAt ? account : null;
}

function adminSession(request) {
  const token = getCookie(request, ADMIN_COOKIE);
  const session = adminSessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > AUTH_MAX_AGE_SECONDS * 1000) {
    adminSessions.delete(token);
    return null;
  }
  return session;
}

function setAuthCookie(response, token, clear = false) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const maxAge = clear ? 0 : AUTH_MAX_AGE_SECONDS;
  response.setHeader("Set-Cookie", `${AUTH_COOKIE}=${clear ? "" : token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

function setAdminCookie(response, token, clear = false) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const maxAge = clear ? 0 : AUTH_MAX_AGE_SECONDS;
  response.setHeader("Set-Cookie", `${ADMIN_COOKIE}=${clear ? "" : token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

function publicSession(session) {
  if (!session) return null;
  const { manageTokenHash, ...safeSession } = session;
  return safeSession;
}

function parseCookiesafeToken(request) {
  const authorization = request.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return token || "";
}

function hasSessionManagementAccess(request, session) {
  const managementToken = parseCookiesafeToken(request);
  if (!managementToken) return false;
  const account = lecturerAccount(request);
  if (!account) return false;
  const tokenEntry = sessionManagementTokens.get(managementToken);
  if (!tokenEntry) return false;
  if (tokenEntry.sessionId !== session.id) return false;
  if (tokenEntry.accountId !== account.id) return false;
  if (tokenEntry.expiresAt <= Date.now()) {
    sessionManagementTokens.delete(managementToken);
    return false;
  }
  return true;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let byteCount = 0;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      byteCount += Buffer.byteLength(chunk);
      if (byteCount > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const deltaLat = radians(lat2 - lat1);
  const deltaLon = radians(lon2 - lon1);
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(deltaLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function expireSessions() {
  const now = Date.now();
  let changed = false;
  const sessions = store.sessions.map((session) => {
    if (session.status === "active" && now >= Date.parse(session.expiresAt)) {
      changed = true;
      return { ...session, status: "expired", endedAt: session.expiresAt };
    }
    return session;
  });
  if (changed) {
    store = { ...store, sessions };
    saveStore(store);
  }
  for (const [token, entry] of sessionManagementTokens.entries()) {
    if (entry.expiresAt <= now || !store.sessions.some((session) => session.id === entry.sessionId && session.status === "active")) {
      sessionManagementTokens.delete(token);
    }
  }
}

function findSession(id) {
  expireSessions();
  return store.sessions.find((session) => session.id === id) || null;
}

function findActiveSession(id) {
  const session = findSession(id);
  return session?.status === "active" ? session : null;
}

function ownedCourse(accountId, courseId) {
  return store.courses.find((course) => course.id === courseId && course.ownerId === accountId) || null;
}

function activeSessionForCourse(courseId) {
  expireSessions();
  return store.sessions.find((session) => session.courseId === courseId && session.status === "active") || null;
}

function validateCourse(body) {
  const course = {
    name: typeof body.name === "string" ? body.name.trim() : "",
    code: typeof body.code === "string" ? body.code.trim() : "",
    lecturer: typeof body.lecturer === "string" ? body.lecturer.trim() : "",
    room: typeof body.room === "string" ? body.room.trim() : "",
    latitude: body.latitude,
    longitude: body.longitude,
    radiusMeters: body.radiusMeters
  };
  if (!course.name || course.name.length > 120 || !course.code || course.code.length > 30 ||
    !course.lecturer || course.lecturer.length > 100 || !course.room || course.room.length > 120 ||
    !Number.isFinite(course.latitude) || course.latitude < -90 || course.latitude > 90 ||
    !Number.isFinite(course.longitude) || course.longitude < -180 || course.longitude > 180 ||
    !Number.isInteger(course.radiusMeters) || course.radiusMeters < 20 || course.radiusMeters > 2000) {
    return null;
  }
  return course;
}

function reportRows(course, start, end) {
  const startTime = Date.parse(`${start}T00:00:00.000Z`);
  const endTime = Date.parse(`${end}T23:59:59.999Z`);
  const sessions = store.sessions.filter((session) =>
    session.courseId === course.id &&
    Date.parse(session.createdAt) >= startTime &&
    Date.parse(session.createdAt) <= endTime
  );
  const sessionIds = new Set(sessions.map((session) => session.id));
  const records = store.attendance.filter((record) =>
    record.courseId === course.id &&
    sessionIds.has(record.sessionId) &&
    Date.parse(record.timestamp) >= startTime &&
    Date.parse(record.timestamp) <= endTime
  );
  const studentMap = new Map();
  store.students.filter((student) => student.courseId === course.id).forEach((student) => {
    studentMap.set(student.id, { id: student.id, name: student.name, program: student.program });
  });
  records.forEach((record) => {
    if (!studentMap.has(record.studentId)) {
      studentMap.set(record.studentId, {
        id: record.studentId,
        name: record.studentName,
        program: record.program || "Former class roster member"
      });
    }
  });
  const rows = [...studentMap.values()].map((student) => {
    const attended = new Set(records
      .filter((record) => record.studentId === student.id)
      .map((record) => record.sessionId)).size;
    return {
      ...student,
      sessionsHeld: sessions.length,
      sessionsAttended: attended,
      attendancePercentage: sessions.length ? Math.round((attended / sessions.length) * 10000) / 100 : 0
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  return { course, start, end, sessionsHeld: sessions.length, rows };
}

function parseReportRange(url) {
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  const isCalendarDate = (value) => isoDate.test(value || "") &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!isCalendarDate(start) || !isCalendarDate(end) || start > end) {
    return null;
  }
  return { start, end };
}

function safeFilename(value) {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "class";
}

async function sendExcelReport(response, report, onGenerated) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Presence Campus";
  workbook.created = new Date();
  workbook.subject = `Attendance report ${report.start} to ${report.end}`;
  const sheet = workbook.addWorksheet("Attendance");
  sheet.columns = [
    { header: "Registration number", key: "id", width: 23 },
    { header: "Student name", key: "name", width: 30 },
    { header: "Programme", key: "program", width: 34 },
    { header: "Sessions attended", key: "sessionsAttended", width: 19 },
    { header: "Sessions held", key: "sessionsHeld", width: 16 },
    { header: "Attendance percentage", key: "attendancePercentage", width: 24 }
  ];
  sheet.addRows(report.rows);
  sheet.insertRow(1, ["Semester attendance report"]);
  sheet.insertRow(2, [report.course.name, report.course.code]);
  sheet.insertRow(3, [`${report.start} to ${report.end}`, `${report.sessionsHeld} sessions held`]);
  sheet.mergeCells("A1:F1");
  sheet.mergeCells("A2:C2");
  sheet.mergeCells("A3:C3");
  sheet.getRow(1).font = { bold: true, size: 16, color: { argb: "FF253B78" } };
  sheet.getRow(2).font = { bold: true, size: 12 };
  sheet.getRow(3).font = { color: { argb: "FF697588" } };
  sheet.getRow(4).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF426CF5" } };
  sheet.views = [{ state: "frozen", ySplit: 4 }];
  sheet.autoFilter = { from: "A4", to: "F4" };
  sheet.getColumn("attendancePercentage").numFmt = '0.00"%"';
  const filename = `${safeFilename(report.course.code)}_attendance_${report.start}_${report.end}.xlsx`;
  const output = Buffer.from(await workbook.xlsx.writeBuffer());
  onGenerated();
  response.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store"
  });
  response.end(output);
}

function sendPdfReport(response, report, onGenerated) {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36, bufferPages: true });
  const filename = `${safeFilename(report.course.code)}_attendance_${report.start}_${report.end}.pdf`;
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  doc.on("end", () => {
    try {
      onGenerated();
    } catch (error) {
      console.error("Could not save attendance export audit event:", error);
      jsonResponse(response, 500, { error: "Could not save the export audit record." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    });
    response.end(Buffer.concat(chunks));
  });
  doc.on("error", (error) => {
    console.error("Could not generate attendance PDF:", error);
    if (!response.headersSent) jsonResponse(response, 500, { error: "Could not generate the PDF report." });
  });
  doc.fontSize(18).fillColor("#253b78").text("Semester attendance report");
  doc.moveDown(0.35).fontSize(11).fillColor("#1d293b")
    .text(`${report.course.name} · ${report.course.code}`);
  doc.fontSize(9).fillColor("#697588")
    .text(`${report.start} to ${report.end} · ${report.sessionsHeld} attendance sessions held`);
  doc.moveDown();

  const columns = [
    { label: "Registration no.", key: "id", width: 112 },
    { label: "Student", key: "name", width: 175 },
    { label: "Programme", key: "program", width: 255 },
    { label: "Attended", key: "sessionsAttended", width: 69 },
    { label: "Sessions held", key: "sessionsHeld", width: 81 },
    { label: "Attendance", key: "attendancePercentage", width: 75 }
  ];
  const tableX = doc.page.margins.left;
  const rowHeight = 24;
  const drawHeader = (y) => {
    doc.save().rect(tableX, y, columns.reduce((sum, column) => sum + column.width, 0), rowHeight)
      .fill("#426cf5").restore();
    let x = tableX + 6;
    columns.forEach((column) => {
      doc.fontSize(8).fillColor("#ffffff").text(column.label, x, y + 8, { width: column.width - 10, lineBreak: false });
      x += column.width;
    });
    return y + rowHeight;
  };
  let y = drawHeader(doc.y);
  report.rows.forEach((student, index) => {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = drawHeader(doc.page.margins.top);
    }
    if (index % 2 === 0) {
      doc.save().rect(tableX, y, columns.reduce((sum, column) => sum + column.width, 0), rowHeight)
        .fill("#f4f6fb").restore();
    }
    let x = tableX + 6;
    columns.forEach((column) => {
      const value = column.key === "attendancePercentage"
        ? `${student[column.key].toFixed(2)}%`
        : String(student[column.key]);
      doc.fontSize(8).fillColor("#354155").text(value, x, y + 8, { width: column.width - 10, lineBreak: false, ellipsis: true });
      x += column.width;
    });
    y += rowHeight;
  });
  if (report.rows.length === 0) {
    doc.fontSize(9).fillColor("#697588").text("No students or attendance records for this class.");
  }
  const pageRange = doc.bufferedPageRange();
  for (let index = 0; index < pageRange.count; index += 1) {
    doc.switchToPage(index);
    doc.fontSize(8).fillColor("#8993a2")
      .text(`Presence Campus · Page ${index + 1} of ${pageRange.count}`, 36, doc.page.height - 24, { align: "right" });
  }
  doc.end();
}

async function handleApi(request, response, url) {
  const route = url.pathname;
  if (request.method === "GET" && route === "/api/admin/status") {
    jsonResponse(response, 200, {
      configured: ADMIN_PASSWORD.length >= 16,
      authenticated: Boolean(adminSession(request))
    });
    return;
  }

  if (request.method === "POST" && route === "/api/admin/login") {
    if (ADMIN_PASSWORD.length < 16) {
      jsonResponse(response, 503, { error: "Owner access is not configured. Set PRESENCE_ADMIN_PASSWORD to a secret of at least 16 characters, then restart the server." });
      return;
    }
    const address = clientAddress(request);
    const rateLimit = applyRateLimit(adminLoginFailures, address);
    if (rateLimit.blocked) {
      response.setHeader("Retry-After", String(Math.ceil(rateLimit.retryAfterMs / 1000)));
      jsonResponse(response, 429, { error: "Too many owner sign-in attempts. Try again in 15 minutes." });
      return;
    }
    const body = await readBody(request);
    const attempted = typeof body.password === "string" ? body.password : "";
    if (!safeEqualHex(hash(ADMIN_PASSWORD), hash(attempted))) {
      adminLoginFailures.set(address, rateLimitState(adminLoginFailures, address));
      jsonResponse(response, 401, { error: "Owner password is not correct." });
      return;
    }
    adminLoginFailures.delete(address);
    const token = randomBytes(32).toString("base64url");
    adminSessions.set(token, { createdAt: Date.now() });
    setAdminCookie(response, token);
    jsonResponse(response, 200, { authenticated: true });
    return;
  }

  if (request.method === "POST" && route === "/api/admin/logout") {
    adminSessions.delete(getCookie(request, ADMIN_COOKIE));
    setAdminCookie(response, "", true);
    jsonResponse(response, 200, { authenticated: false });
    return;
  }

  if (request.method === "GET" && route === "/api/admin/lecturers") {
    jsonResponse(response, 200, {
      lecturers: store.accounts.map((account) => ({
        id: account.id,
        name: account.name,
        email: account.email,
        createdAt: account.createdAt,
        classCount: store.courses.filter((course) => course.ownerId === account.id).length,
        active: !account.disabledAt
      }))
    });
    return;
  }

  const lecturerAdminMatch = route.match(/^\/api\/admin\/lecturers\/([^/]+)$/);
  if (lecturerAdminMatch && request.method === "PATCH") {
    const lecturerId = decodeURIComponent(lecturerAdminMatch[1]);
    const account = store.accounts.find((entry) => entry.id === lecturerId);
    if (!account) {
      jsonResponse(response, 404, { error: "Lecturer account was not found." });
      return;
    }
    const body = await readBody(request);
    if (typeof body.disabled !== "boolean") {
      jsonResponse(response, 400, { error: "Choose whether to suspend or reactivate this lecturer account." });
      return;
    }
    if (body.disabled) {
      account.disabledAt = new Date().toISOString();
      delete account.recoveryTokenHash;
      delete account.recoveryExpiresAt;
      for (const [token, session] of lecturerSessions) {
        if (session.accountId === account.id) lecturerSessions.delete(token);
      }
    } else {
      delete account.disabledAt;
    }
    saveStore(store);
    jsonResponse(response, 200, { active: !account.disabledAt });
    return;
  }

  const lecturerRecoveryMatch = route.match(/^\/api\/admin\/lecturers\/([^/]+)\/recovery$/);
  if (lecturerRecoveryMatch && request.method === "POST") {
    const account = store.accounts.find((entry) => entry.id === decodeURIComponent(lecturerRecoveryMatch[1]));
    if (!account || account.disabledAt) {
      jsonResponse(response, 404, { error: "An active lecturer account was not found." });
      return;
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    account.recoveryTokenHash = hash(token);
    account.recoveryExpiresAt = expiresAt;
    addAuditEvent({
      action: "account.recovery_issued",
      actorType: "owner",
      actorId: "owner",
      actorName: "Site owner",
      targetId: account.id,
      details: { expiresAt }
    });
    saveStore(store);
    jsonResponse(response, 201, { token, expiresAt });
    return;
  }

  if (request.method === "GET" && route === "/api/admin/invitations") {
    jsonResponse(response, 200, {
      invitations: store.invitations.map(({ id, createdAt, expiresAt, createdBy, purpose }) => ({
        id,
        createdAt,
        expiresAt,
        createdBy,
        purpose,
        expired: Date.now() >= Date.parse(expiresAt)
      }))
    });
    return;
  }

  if (request.method === "POST" && route === "/api/admin/invitations") {
    const code = makeInvitationCode();
    const invitation = {
      id: randomBytes(12).toString("hex"),
      codeHash: hash(code),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + INVITATION_MAX_AGE_MS).toISOString(),
      createdBy: "owner",
      purpose: "signup"
    };
    store.invitations.push(invitation);
    saveStore(store);
    jsonResponse(response, 201, { id: invitation.id, code, expiresAt: invitation.expiresAt });
    return;
  }

  const invitationDeleteMatch = route.match(/^\/api\/admin\/invitations\/([^/]+)$/);
  if (invitationDeleteMatch && request.method === "DELETE") {
    const invitationId = decodeURIComponent(invitationDeleteMatch[1]);
    const index = store.invitations.findIndex((invite) => invite.id === invitationId);
    if (index < 0) {
      jsonResponse(response, 404, { error: "Invitation was not found or has already been used." });
      return;
    }
    store.invitations.splice(index, 1);
    saveStore(store);
    jsonResponse(response, 200, { revoked: true });
    return;
  }

  if (request.method === "GET" && route === "/api/auth/status") {
    jsonResponse(response, 200, {
      authenticated: Boolean(lecturerAccount(request)),
      hasInvitation: store.invitations.some((invite) => Date.now() < Date.parse(invite.expiresAt))
    });
    return;
  }

  if (request.method === "POST" && route === "/api/auth/signup") {
    const body = await readBody(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const invitationCode = typeof body.invitationCode === "string" ? body.invitationCode.trim().toUpperCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
      name.length < 2 || name.length > 100 || password.length < 12 || password.length > 128) {
      jsonResponse(response, 400, { error: "Enter a valid email and name, and choose a password between 12 and 128 characters." });
      return;
    }
    if (store.accounts.some((account) => account.email === email)) {
      jsonResponse(response, 409, { error: "An account already exists for that email address." });
      return;
    }
    let invitationIndex = -1;
    if (invitationCode) {
      invitationIndex = store.invitations.findIndex((invite) =>
        invite.purpose !== "used" &&
        Date.now() < Date.parse(invite.expiresAt) &&
        safeEqualHex(invite.codeHash, hash(invitationCode))
      );
    }
    if (invitationIndex < 0) {
      jsonResponse(response, 403, { error: "A valid, unused lecturer invitation code is required to sign up." });
      return;
    }
    const salt = randomBytes(16).toString("hex");
    const passwordHash = (await scryptAsync(password, salt, 64)).toString("hex");
    if (invitationIndex >= 0) store.invitations.splice(invitationIndex, 1);
    const account = { id: randomBytes(16).toString("hex"), name, email, salt, passwordHash, createdAt: new Date().toISOString() };
    store.accounts.push(account);
    saveStore(store);
    const token = randomBytes(32).toString("base64url");
    lecturerSessions.set(token, { accountId: account.id, createdAt: Date.now() });
    setAuthCookie(response, token);
    jsonResponse(response, 201, { authenticated: true, lecturer: { id: account.id, name, email } });
    return;
  }

  if (request.method === "POST" && route === "/api/auth/recovery") {
    const body = await readBody(request);
    const token = typeof body.token === "string" ? body.token : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 12 || password.length > 128) {
      jsonResponse(response, 400, { error: "Choose a password between 12 and 128 characters." });
      return;
    }
    const account = store.accounts.find((entry) =>
      !entry.disabledAt &&
      entry.recoveryTokenHash &&
      Date.now() < Date.parse(entry.recoveryExpiresAt) &&
      safeEqualHex(entry.recoveryTokenHash, hash(token))
    );
    if (!account) {
      jsonResponse(response, 410, { error: "This password recovery link is invalid or has expired. Ask the site owner for a new one." });
      return;
    }
    account.salt = randomBytes(16).toString("hex");
    account.passwordHash = (await scryptAsync(password, account.salt, 64)).toString("hex");
    delete account.recoveryTokenHash;
    delete account.recoveryExpiresAt;
    for (const [sessionToken, session] of lecturerSessions) {
      if (session.accountId === account.id) lecturerSessions.delete(sessionToken);
    }
    addAuditEvent({
      action: "account.password_recovered",
      actorType: "lecturer",
      actorId: account.id,
      actorName: account.name,
      targetId: account.id,
      details: {}
    });
    saveStore(store);
    jsonResponse(response, 200, { recovered: true });
    return;
  }

  if (request.method === "POST" && route === "/api/auth/login") {
    const body = await readBody(request);
    const address = clientAddress(request);
    const rateLimit = applyRateLimit(loginFailures, address);
    if (rateLimit.blocked) {
      response.setHeader("Retry-After", String(Math.ceil(rateLimit.retryAfterMs / 1000)));
      jsonResponse(response, 429, { error: "Too many sign-in attempts. Try again in 15 minutes." });
      return;
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const account = store.accounts.find((entry) => entry.email === email);
    const attempted = account && typeof body.password === "string"
      ? (await scryptAsync(body.password, account.salt, 64)).toString("hex")
      : "";
    if (!account || account.disabledAt || !safeEqualHex(account.passwordHash, attempted)) {
      loginFailures.set(address, rateLimitState(loginFailures, address));
      jsonResponse(response, 401, { error: "Email or password is not correct." });
      return;
    }
    loginFailures.delete(address);
    const token = randomBytes(32).toString("base64url");
    lecturerSessions.set(token, { accountId: account.id, createdAt: Date.now() });
    setAuthCookie(response, token);
    jsonResponse(response, 200, { authenticated: true, lecturer: { id: account.id, name: account.name, email: account.email } });
    return;
  }

  if (request.method === "POST" && route === "/api/auth/logout") {
    lecturerSessions.delete(getCookie(request, AUTH_COOKIE));
    setAuthCookie(response, "", true);
    jsonResponse(response, 200, { authenticated: false });
    return;
  }

  if (request.method === "GET" && route === "/api/auth/me") {
    const account = lecturerAccount(request);
    if (!account) {
      jsonResponse(response, 401, { error: "Lecturer sign-in is required." });
      return;
    }
    jsonResponse(response, 200, { lecturer: { id: account.id, name: account.name, email: account.email } });
    return;
  }

  if (request.method === "GET" && route === "/api/courses") {
    const account = lecturerAccount(request);
    if (!account) {
      jsonResponse(response, 401, { error: "Lecturer sign-in is required." });
      return;
    }
    jsonResponse(response, 200, {
      lecturer: { id: account.id, name: account.name, email: account.email },
      courses: store.courses.filter((course) => course.ownerId === account.id)
    });
    return;
  }

  const reportMatch = route.match(/^\/api\/courses\/([^/]+)\/reports\.(xlsx|pdf)$/);
  if (reportMatch && request.method === "GET") {
    const account = lecturerAccount(request);
    if (!account) {
      jsonResponse(response, 401, { error: "Lecturer sign-in is required." });
      return;
    }
    const course = ownedCourse(account.id, decodeURIComponent(reportMatch[1]));
    const range = parseReportRange(url);
    if (!course) {
      jsonResponse(response, 404, { error: "Class not found." });
      return;
    }
    if (!range) {
      jsonResponse(response, 400, { error: "Choose a valid semester start and end date." });
      return;
    }
    const report = reportRows(course, range.start, range.end);
    const recordExport = () => {
      lecturerAuditEvent(account, course.id, "report.exported", null, {
        format: reportMatch[2],
        start: range.start,
        end: range.end,
        sessionsHeld: report.sessionsHeld,
        studentCount: report.rows.length
      });
      saveStore(store);
    };
    if (reportMatch[2] === "xlsx") await sendExcelReport(response, report, recordExport);
    else sendPdfReport(response, report, recordExport);
    return;
  }

  const courseAuditMatch = route.match(/^\/api\/courses\/([^/]+)\/audit$/);
  if (courseAuditMatch && request.method === "GET") {
    const account = lecturerAccount(request);
    if (!account) {
      jsonResponse(response, 401, { error: "Lecturer sign-in is required." });
      return;
    }
    const course = ownedCourse(account.id, decodeURIComponent(courseAuditMatch[1]));
    if (!course) {
      jsonResponse(response, 404, { error: "Class not found." });
      return;
    }
    jsonResponse(response, 200, { events: courseAuditTrail(course.id, 100) });
    return;
  }

  const reportPreviewMatch = route.match(/^\/api\/courses\/([^/]+)\/report$/);
  if (reportPreviewMatch && request.method === "GET") {
    const account = lecturerAccount(request);
    if (!account) {
      jsonResponse(response, 401, { error: "Lecturer sign-in is required." });
      return;
    }
    const course = ownedCourse(account.id, decodeURIComponent(reportPreviewMatch[1]));
    const range = parseReportRange(url);
    if (!course) {
      jsonResponse(response, 404, { error: "Class not found." });
      return;
    }
    if (!range) {
      jsonResponse(response, 400, { error: "Choose a valid semester start and end date." });
      return;
    }
    const report = reportRows(course, range.start, range.end);
    jsonResponse(response, 200, report);
    return;
  }

  const attendanceCorrectionMatch = route.match(/^\/api\/courses\/([^/]+)\/attendance\/([^/]+)\/([^/]+)$/);
  if (attendanceCorrectionMatch && request.method === "DELETE") {
    const account = lecturerAccount(request);
    if (!account) {
      jsonResponse(response, 401, { error: "Lecturer sign-in is required." });
      return;
    }
    const courseId = decodeURIComponent(attendanceCorrectionMatch[1]);
    if (!ownedCourse(account.id, courseId)) {
      jsonResponse(response, 404, { error: "Class not found." });
      return;
    }
    const sessionId = decodeURIComponent(attendanceCorrectionMatch[2]);
    const studentId = decodeURIComponent(attendanceCorrectionMatch[3]);
    const body = await readBody(request);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 8 || reason.length > 500) {
      jsonResponse(response, 400, { error: "Enter a correction reason between 8 and 500 characters." });
      return;
    }
    const index = store.attendance.findIndex((entry) =>
      entry.courseId === courseId && entry.sessionId === sessionId && entry.studentId === studentId
    );
    if (index < 0) {
      jsonResponse(response, 404, { error: "The attendance record was not found." });
      return;
    }
    const [record] = store.attendance.splice(index, 1);
    lecturerAuditEvent(account, courseId, "attendance.corrected", record.id, {
      sessionId: record.sessionId,
      studentId: record.studentId,
      studentName: record.studentName,
      previousTimestamp: record.timestamp,
      reason
    });
    saveStore(store);
    jsonResponse(response, 200, { corrected: true });
    return;
  }

  const courseMatch = route.match(/^\/api\/courses\/([^/]+)$/);
  if (courseMatch && request.method === "PUT") {
    const account = lecturerAccount(request);
    if (!account) {
      jsonResponse(response, 401, { error: "Lecturer sign-in is required." });
      return;
    }
    const id = decodeURIComponent(courseMatch[1]);
    const existing = ownedCourse(account.id, id);
    if (!existing) {
      jsonResponse(response, 404, { error: "Class not found." });
      return;
    }
    if (activeSessionForCourse(id)) {
      jsonResponse(response, 409, { error: "End the active attendance session before editing class details." });
      return;
    }
    const course = validateCourse(await readBody(request));
    if (!course) {
      jsonResponse(response, 400, { error: "Enter valid class details, venue coordinates, and a radius from 20 to 2,000 metres." });
      return;
    }
    Object.assign(existing, course);
    saveStore(store);
    jsonResponse(response, 200, { course: existing });
    return;
  }

  if (request.method === "POST" && route === "/api/courses") {
    const account = lecturerAccount(request);
    if (!account) {
      jsonResponse(response, 401, { error: "Lecturer sign-in is required." });
      return;
    }
    const course = validateCourse(await readBody(request));
    if (!course) {
      jsonResponse(response, 400, { error: "Enter valid class details, venue coordinates, and a radius from 20 to 2,000 metres." });
      return;
    }
    const savedCourse = { ...course, id: randomBytes(16).toString("hex"), ownerId: account.id, createdAt: new Date().toISOString() };
    store.courses.push(savedCourse);
    saveStore(store);
    jsonResponse(response, 201, { course: savedCourse });
    return;
  }

  const studentsCollectionMatch = route.match(/^\/api\/courses\/([^/]+)\/students$/);
  if (studentsCollectionMatch && request.method === "POST") {
    const account = lecturerAccount(request);
    if (!account) {
      jsonResponse(response, 401, { error: "Lecturer sign-in is required." });
      return;
    }
    const courseId = decodeURIComponent(studentsCollectionMatch[1]);
    if (!ownedCourse(account.id, courseId)) {
      jsonResponse(response, 404, { error: "Class not found." });
      return;
    }
    const body = await readBody(request);
    const student = {
      id: typeof body.id === "string" ? body.id.trim() : "",
      name: typeof body.name === "string" ? body.name.trim() : "",
      program: typeof body.program === "string" ? body.program.trim() : ""
    };
    if (!/^[A-Za-z0-9-]{4,16}$/.test(student.id) || student.name.length < 2 ||
      student.name.length > 100 || student.program.length > 120) {
      jsonResponse(response, 400, { error: "Enter a valid registration number and student name." });
      return;
    }
    if (store.students.some((entry) => entry.courseId === courseId && entry.id.toLowerCase() === student.id.toLowerCase())) {
      jsonResponse(response, 409, { error: "That registration number is already on this class roster." });
      return;
    }
    const savedStudent = { ...student, courseId, active: true };
    store.students.push(savedStudent);
    saveStore(store);
    jsonResponse(response, 201, { student: savedStudent });
    return;
  }

  const studentDeleteMatch = route.match(/^\/api\/courses\/([^/]+)\/students\/([^/]+)$/);
  if (studentDeleteMatch && request.method === "DELETE") {
    const account = lecturerAccount(request);
    if (!account) {
      jsonResponse(response, 401, { error: "Lecturer sign-in is required." });
      return;
    }
    const courseId = decodeURIComponent(studentDeleteMatch[1]);
    const id = decodeURIComponent(studentDeleteMatch[2]);
    if (!ownedCourse(account.id, courseId)) {
      jsonResponse(response, 404, { error: "Class not found." });
      return;
    }
    const student = store.students.find((entry) => entry.courseId === courseId && entry.id === id && entry.active);
    if (!student) {
      jsonResponse(response, 404, { error: "Student was not found on this class roster." });
      return;
    }
    student.active = false;
    saveStore(store);
    jsonResponse(response, 200, { removed: id });
    return;
  }

  if (request.method === "GET" && route === "/api/state") {
    const account = lecturerAccount(request);
    if (!account) {
      jsonResponse(response, 401, { error: "Lecturer sign-in is required." });
      return;
    }
    expireSessions();
    const courses = store.courses.filter((course) => course.ownerId === account.id);
    const requestedId = url.searchParams.get("courseId");
    const course = courses.find((entry) => entry.id === requestedId) || courses[0] || null;
    const students = course
      ? store.students.filter((student) => student.courseId === course.id && student.active)
      : [];
    const session = course ? activeSessionForCourse(course.id) : null;
    const attendance = course ? store.attendance.filter((record) => record.courseId === course.id) : [];
    const audit = course ? courseAuditTrail(course.id, 100) : [];
    jsonResponse(response, 200, { lecturer: { id: account.id, name: account.name, email: account.email }, courses, course, students, session: publicSession(session), attendance, audit });
    return;
  }

  if (request.method === "GET" && route === "/api/sessions") {
    const account = lecturerAccount(request);
    if (!account) {
      jsonResponse(response, 401, { error: "Lecturer sign-in is required." });
      return;
    }
    const courseId = url.searchParams.get("courseId");
    if (!ownedCourse(account.id, courseId)) {
      jsonResponse(response, 404, { error: "Class not found." });
      return;
    }
    expireSessions();
    jsonResponse(response, 200, {
      sessions: store.sessions.filter((session) => session.courseId === courseId).map(publicSession)
    });
    return;
  }

  const sessionStudentMatch = route.match(/^\/api\/sessions\/([^/]+)\/students\/([^/]+)$/);
  if (sessionStudentMatch && request.method === "GET") {
    const session = findActiveSession(decodeURIComponent(sessionStudentMatch[1]));
    if (!session) {
      jsonResponse(response, 410, { error: "This check-in link has expired. Ask your lecturer for a current QR code." });
      return;
    }
    const id = decodeURIComponent(sessionStudentMatch[2]).toLowerCase();
    const student = store.students.find((entry) => entry.courseId === session.courseId && entry.id.toLowerCase() === id && entry.active);
    if (!student) {
      jsonResponse(response, 404, { error: "No active student with that registration number is on this class roster." });
      return;
    }
    jsonResponse(response, 200, { student: { id: student.id, name: student.name, program: student.program } });
    return;
  }

  const studentAttendanceMatch = route.match(/^\/api\/sessions\/([^/]+)\/attendance$/);
  if (studentAttendanceMatch && request.method === "POST") {
    const sessionId = decodeURIComponent(studentAttendanceMatch[1]);
    const session = findActiveSession(sessionId);
    if (!session) {
      jsonResponse(response, 410, { error: "This attendance link has expired or been closed." });
      return;
    }
    const course = store.courses.find((entry) => entry.id === session.courseId);
    if (!course) {
      jsonResponse(response, 409, { error: "This class is no longer available." });
      return;
    }
    const body = await readBody(request);
    const studentId = typeof body.studentId === "string" ? body.studentId.trim() : "";
    if (!/^[A-Za-z0-9-]{4,16}$/.test(studentId)) {
      jsonResponse(response, 400, { error: "Enter a valid registration number for this class roster." });
      return;
    }
    const student = store.students.find((entry) => entry.courseId === course.id && entry.id === studentId && entry.active);
    if (!student) {
      jsonResponse(response, 404, { error: "This registration number is not on this class roster." });
      return;
    }
    if (!Number.isFinite(body.latitude) || body.latitude < -90 || body.latitude > 90 ||
      !Number.isFinite(body.longitude) || body.longitude < -180 || body.longitude > 180 ||
      !Number.isFinite(body.accuracy) || body.accuracy < 0 || body.accuracy > 150) {
      jsonResponse(response, 400, { error: "A precise location check is required to submit attendance." });
      return;
    }
    if (typeof body.selfieCaptured !== "boolean" || !body.selfieCaptured) {
      jsonResponse(response, 400, { error: "Capture a check-in photo before submitting." });
      return;
    }
    const distance = distanceMeters(body.latitude, body.longitude, course.latitude, course.longitude);
    if (distance > course.radiusMeters) {
      jsonResponse(response, 403, { error: `You are outside the ${course.radiusMeters} m class check-in area.` });
      return;
    }
    if (store.attendance.some((entry) => entry.sessionId === sessionId && entry.studentId === studentId)) {
      jsonResponse(response, 409, { error: "Attendance has already been recorded for this student in this session." });
      return;
    }
    const record = {
      id: randomBytes(16).toString("hex"),
      courseId: course.id,
      sessionId,
      studentId,
      studentName: student.name,
      program: student.program,
      timestamp: new Date().toISOString(),
      distanceMeters: Math.round(distance),
      faceVerification: "not-enabled-in-prototype"
    };
    store.attendance.push(record);
    addAuditEvent({
      courseId: course.id,
      action: "attendance.recorded",
      actorType: "student",
      actorId: student.id,
      actorName: student.name,
      targetId: record.id,
      details: {
        sessionId,
        studentId: student.id,
        studentName: student.name,
        timestamp: record.timestamp
      }
    });
    saveStore(store);
    jsonResponse(response, 201, { record });
    return;
  }

  const publicSessionMatch = route.match(/^\/api\/sessions\/([^/]+)$/);
  if (publicSessionMatch && request.method === "GET") {
    const session = findActiveSession(decodeURIComponent(publicSessionMatch[1]));
    if (!session) {
      jsonResponse(response, 410, { error: "This check-in link has expired. Ask your lecturer for a current QR code." });
      return;
    }
    const course = store.courses.find((entry) => entry.id === session.courseId);
    if (!course) {
      jsonResponse(response, 410, { error: "This class is no longer available." });
      return;
    }
    jsonResponse(response, 200, {
      session: publicSession(session),
      course: { name: course.name, code: course.code, room: course.room, latitude: course.latitude, longitude: course.longitude, radiusMeters: course.radiusMeters }
    });
    return;
  }

  if (request.method === "POST" && route === "/api/sessions") {
    const account = lecturerAccount(request);
    if (!account) {
      jsonResponse(response, 401, { error: "Lecturer sign-in is required." });
      return;
    }
    const body = await readBody(request);
    const courseId = typeof body.courseId === "string" ? body.courseId : "";
    const durationMinutes = body.durationMinutes;
    if (!ownedCourse(account.id, courseId)) {
      jsonResponse(response, 404, { error: "Class not found." });
      return;
    }
    if (activeSessionForCourse(courseId)) {
      jsonResponse(response, 409, { error: "An attendance session is already active. Close it or wait for it to expire." });
      return;
    }
    if (!store.students.some((student) => student.courseId === courseId && student.active)) {
      jsonResponse(response, 409, { error: "Add students to this class roster before opening attendance." });
      return;
    }
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 480) {
      jsonResponse(response, 400, { error: "Choose an expiry between 1 and 480 minutes." });
      return;
    }
    const managementToken = randomBytes(32).toString("base64url");
    const session = {
      id: randomBytes(32).toString("base64url"),
      courseId,
      manageTokenHash: hash(managementToken),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + durationMinutes * 60 * 1000).toISOString(),
      status: "active"
    };
    sessionManagementTokens.set(managementToken, {
      sessionId: session.id,
      courseId,
      accountId: account.id,
      issuedAt: Date.now(),
      expiresAt: Date.now() + Math.min(8 * 60 * 60 * 1000, durationMinutes * 60 * 1000)
    });
    store.sessions.push(session);
    saveStore(store);
    jsonResponse(response, 201, { session: publicSession(session), managementToken });
    return;
  }

  const sessionMatch = route.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && request.method === "PATCH") {
    const session = findSession(decodeURIComponent(sessionMatch[1]));
    if (!session || session.status !== "active") {
      jsonResponse(response, 410, { error: "That attendance session has expired or been closed." });
      return;
    }
    if (!hasSessionManagementAccess(request, session)) {
      jsonResponse(response, 403, { error: "Only the lecturer who opened this session can change its expiry." });
      return;
    }
    const body = await readBody(request);
    if (!Number.isInteger(body.durationMinutes) || body.durationMinutes < 1 || body.durationMinutes > 480) {
      jsonResponse(response, 400, { error: "Choose an expiry between 1 and 480 minutes from now." });
      return;
    }
    session.expiresAt = new Date(Date.now() + body.durationMinutes * 60 * 1000).toISOString();
    saveStore(store);
    jsonResponse(response, 200, { session: publicSession(session) });
    return;
  }

  if (sessionMatch && request.method === "DELETE") {
    const session = findSession(decodeURIComponent(sessionMatch[1]));
    if (!session || session.status !== "active") {
      jsonResponse(response, 404, { error: "That attendance session is not active." });
      return;
    }
    if (!hasSessionManagementAccess(request, session)) {
      jsonResponse(response, 403, { error: "Only the lecturer who opened this session can close it." });
      return;
    }
    session.status = "closed";
    session.endedAt = new Date().toISOString();
    for (const [token, entry] of sessionManagementTokens.entries()) {
      if (entry.sessionId === session.id) sessionManagementTokens.delete(token);
    }
    saveStore(store);
    jsonResponse(response, 200, { ended: true });
    return;
  }

  jsonResponse(response, 404, { error: "API route not found." });
}

const publicFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/admin", ["admin.html", "text/html; charset=utf-8"]],
  ["/admin/", ["admin.html", "text/html; charset=utf-8"]],
  ["/admin.html", ["admin.html", "text/html; charset=utf-8"]],
  ["/admin.js", ["admin.js", "text/javascript; charset=utf-8"]],
  ["/theme.js", ["theme.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/check-in.js", ["check-in.js", "text/javascript; charset=utf-8"]],
  ["/check-in-machine.js", ["check-in-machine.js", "text/javascript; charset=utf-8"]],
  ["/reset.js", ["reset.js", "text/javascript; charset=utf-8"]],
  ["/check-in-expired.html", ["check-in-expired.html", "text/html; charset=utf-8"]],
  ["/vendor/qrcode.js", ["node_modules/qrcode-generator/dist/qrcode.js", "text/javascript; charset=utf-8"]]
]);

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const startedAt = Date.now();
  const routeClass = url.pathname.startsWith("/api/")
    ? "api"
    : url.pathname === "/check-in" ? "student-check-in"
      : url.pathname === "/admin" ? "owner-admin"
        : url.pathname === "/" ? "lecturer-portal" : "static";
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(self), geolocation=(self), microphone=()");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'");
  if (production) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  response.on("finish", () => {
    console.log(JSON.stringify({
      event: "http_request",
      method: request.method,
      route: routeClass,
      status: response.statusCode,
      durationMs: Date.now() - startedAt
    }));
  });
  try {
    if (production && url.pathname !== "/healthz") {
      const forwardedProto = String(request.headers["x-forwarded-proto"] || "")
        .split(",")[0].trim().toLowerCase();
      if (forwardedProto !== "https") {
        response.writeHead(426, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        response.end("HTTPS is required.");
        return;
      }
    }
    if (url.pathname === "/healthz") {
      if (request.method !== "GET") {
        jsonResponse(response, 405, { error: "Method not allowed." });
        return;
      }
      jsonResponse(response, 200, { status: "ok" });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const publicAuthRoute = [
        "/api/auth/status",
        "/api/auth/signup",
        "/api/auth/login",
        "/api/auth/recovery",
        "/api/auth/logout"
      ].includes(url.pathname);
      const publicStudentRoute =
        (request.method === "GET" && /^\/api\/sessions\/[^/]+$/.test(url.pathname)) ||
        (request.method === "GET" && /^\/api\/sessions\/[^/]+\/students\/[^/]+$/.test(url.pathname)) ||
        (request.method === "POST" && /^\/api\/sessions\/[^/]+\/attendance$/.test(url.pathname));
      const publicAdminRoute = [
        "/api/admin/status",
        "/api/admin/login",
        "/api/admin/logout"
      ].includes(url.pathname);
      if (url.pathname.startsWith("/api/admin/")) {
        if (!publicAdminRoute && !adminSession(request)) {
          jsonResponse(response, 401, { error: "Owner sign-in is required." });
          return;
        }
        await handleApi(request, response, url);
        return;
      }
      if (!publicAuthRoute && !publicStudentRoute && !lecturerAccount(request)) {
        jsonResponse(response, 401, { error: "Lecturer sign-in is required." });
        return;
      }
      await handleApi(request, response, url);
      return;
    }
    if (url.pathname === "/check-in" || url.pathname === "/check-in/") {
      const sessionId = url.searchParams.get("session");
      if (request.method !== "GET" || !sessionId || !findActiveSession(sessionId)) {
        response.writeHead(410, {
          "Content-Type": "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer"
        });
        response.end(fs.readFileSync(path.join(root, "check-in-expired.html")));
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer"
      });
      response.end(fs.readFileSync(path.join(root, "check-in.html")));
      return;
    }
    if (url.pathname === "/lecturer/reset" && request.method === "GET") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer"
      });
      response.end(fs.readFileSync(path.join(root, "reset.html")));
      return;
    }
    if ((url.pathname === "/lecturer/signup" || url.pathname === "/lecturer/activate" || url.pathname === "/lecturer/login") && request.method === "GET") {
      const auth = url.pathname === "/lecturer/login" ? "login" : "signup";
      const invite = url.searchParams.get("invite");
      const query = new URLSearchParams({ auth });
      if (invite) query.set("invite", invite);
      response.writeHead(302, { Location: `/?${query}`, "Cache-Control": "no-store" });
      response.end();
      return;
    }
    const file = publicFiles.get(url.pathname);
    if (!file || request.method !== "GET") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": file[1],
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store"
    });
    response.end(fs.readFileSync(path.join(root, file[0])));
  } catch (error) {
    if (response.headersSent || response.destroyed) return;
    const status = error.status || 500;
    if (status === 500) {
      if (production) {
        console.error(JSON.stringify({ event: "request_error", method: request.method, route: routeClass, error: error.name }));
      } else {
        console.error("Request failed:", error);
      }
    }
    jsonResponse(response, status, { error: status === 500 ? "The request could not be completed." : error.message });
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.listen(port, bindHost, () => {
  const endpoint = production
    ? `internal HTTP ${bindHost}:${port} behind HTTPS proxy`
    : `http://${bindHost}:${port}`;
  console.log(`Presence lecturer portal listening on ${endpoint}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: "server_shutdown", signal }));
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  server.close(() => {
    saveStore(store);
    clearTimeout(timeout);
    process.exit(0);
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
