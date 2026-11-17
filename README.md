# Presence Campus

Lecturer-led class attendance application with lecturer accounts, class rosters, timed student check-in links, and semester attendance reports.

## Run locally

1. Install Node.js 18 or newer.
2. Run `npm install`.
3. Set `PRESENCE_ADMIN_PASSWORD` to a private password of at least 16 characters. In PowerShell: `$env:PRESENCE_ADMIN_PASSWORD = "your-private-owner-password"`.
4. Run `npm start`.
5. Open `http://localhost:3000/admin`, sign in as the owner, and create a lecturer invitation link.
6. Open that link to create the first lecturer account. Create additional lecturer accounts with new owner-generated invitations.
7. Add a class, set its venue coordinates and check-in radius, and add its roster.
8. Set the link expiry and generate the class QR code. Students use the separate check-in dashboard opened by this active lecturer link.

Run `npm test` to execute the automated HTTP integration tests using an isolated temporary data directory.

See [STATE-MACHINES.md](./STATE-MACHINES.md) for the application’s stateful workflow inventory and the enforced student check-in transition model.

Lecturer account activation requires a one-use invitation code issued by the site owner. The activation link opens `/lecturer/activate`; no public lecturer self-registration or email-domain bypass is available. Only the site owner can create and revoke invitations or suspend/reactivate lecturer accounts from `/admin`; lecturer accounts cannot access these controls. Suspended lecturers are signed out and cannot log back in; their class and attendance records are retained. The owner password is never stored in the application data and has no default value. Owner administration uses a separate HttpOnly, SameSite cookie and sign-in from lecturer accounts. Invitation links expire after 48 hours. Lecturer accounts can each manage multiple classes.

The lecturer sign-in page links to owner administration at `/admin`. The site-wide theme switch follows the device preference initially and remembers a user's light/dark choice in that browser. Session expiry can be entered in either minutes or hours (up to 8 hours). The product footer links to Eagletech HQ.

An attendance link remains usable only while its session is active. The lecturer can edit the expiry (1 minute to 8 hours from the time of the update) or close it immediately. Session-management tokens are separate from student QR tokens and are kept in the lecturer's browser session storage.

## Semester reports

Select an inclusive start and end date in a class's Attendance report panel to calculate each student's attendance percentage and download an Excel or PDF report. The denominator is the number of sessions created within the selected UTC date range; the numerator is the student's distinct attended sessions in that period. Percentages are rounded to two decimal places. A period with no sessions reports 0%.

## Attendance policy and audit

- One attendance record is accepted for a rostered student in each session. A second submission for the same student and session is rejected.
- Check-in is accepted only while the lecturer-issued session is active. Ending or expiring the link closes attendance; late submissions are not accepted.
- The browser must report a location accuracy between 0 and 150 metres, and the reported coordinates must be within the class's configured radius. GPS values are browser-reported and do not prove resistance to location spoofing.
- A lecturer can correct recorded attendance from the class audit trail. Each correction removes the selected check-in only after a reason is entered; the audit event retains the actor, student/session, previous check-in time, and reason.
- Excel/PDF report exports are audited with the lecturer, format, date range, session count, and student count. The dashboard shows recent class activity; the full audit log is stored with application data.
- Student check-in displays a terms and data-use dialog before requesting class/session details. Students must accept for that page visit before lookup or location verification can begin. Registration numbers are used for roster lookup; browser-reported location is used to verify proximity, while the stored attendance record contains the rounded distance rather than raw coordinates. The camera photo remains on the device and is not uploaded or saved; face identity matching is not enabled. Browser location and camera permissions are separate.

Audit history contains student-identifying information and must be access-controlled and retained only according to institutional policy. The JSON-file audit log is operationally useful but is not tamper-proof; a production system should move it to an append-only, access-controlled database or audit service.

## Production operations

The included controls are deployment safeguards, not a declaration that the local JSON application is production-ready. Do not use it for real student records until storage is migrated to an institution-managed database with concurrency controls and tested backups.

- Set `NODE_ENV=production`, `PRESENCE_ADMIN_PASSWORD` to a unique secret of at least 16 characters, and `PRESENCE_TRUST_PROXY=true`. The application refuses to start in production without these settings.
- Terminate TLS at a trusted reverse proxy. The proxy must overwrite (not merely pass through) `X-Forwarded-Proto` and `X-Forwarded-For`, forward `https` for secure requests, and be the only network path to the application. Forwarded client IPs are used for sign-in rate limits only when this trusted-proxy mode is enabled. In production the service binds to `127.0.0.1` by default; for a container network set `PRESENCE_BIND_HOST=0.0.0.0` and restrict the application port to the proxy. The application rejects non-HTTPS forwarded requests, sets secure cookies, and emits HSTS and browser security headers.
- `GET /healthz` provides a minimal process health check and reveals no application data. Request logs are JSON lines containing method, broad route category, status, and duration; query strings, registration numbers, and tokens are omitted. Forward these logs to monitored infrastructure and alert on unhealthy probes and repeated server errors.
- Set `PRESENCE_DATA_DIR` to a persistent, access-restricted directory outside the web root if using the local store. Stop the service before copying `store.json`; verify backups by restoring to a separate test environment. Keep secrets and backups out of source control. The local JSON store still does not support safe concurrent multi-instance use.
- For lecturer account recovery, the owner can issue a single-use link from `/admin`. The link expires after 30 minutes, invalidates the lecturer's existing sessions when used, and should be delivered to the verified lecturer using a private channel. Issuing and completing a recovery are recorded in the store's audit log. A compromised owner password still requires changing the deployment secret and restarting the service.
- Graceful shutdown handles `SIGINT` and `SIGTERM`; the process should run under a supervisor that restarts failures and preserves its data directory.

## Phone access

To scan the lecturer's QR from a phone, host the server at an address the phone can reach and use HTTPS. Phone browsers require a secure context for camera and location permissions. Set the course venue using the lecturer device's current location while in the lecture room, or enter its coordinates.

## Storage and security status

Class details, rosters, lecturer accounts, invitations, attendance sessions, attendance, and audit events are stored in `data/store.json` by default. A new installation creates a blank store; no class or student records are prefilled. Passwords are stored as salted scrypt hashes. Invitation codes and password recovery tokens are stored as hashes after creation and can be used once.

This is an early implementation, not a production-ready deployment. A QR token is a bearer link: anyone who receives it while active can open the student page, though only rostered registration numbers can proceed. The operational safeguards above do not replace a production database, tested backup/restore, tamper-resistant audit storage, and an institution-approved verification process before using real student records.

The camera step captures a photo locally and does not upload, persist, or compare it against an enrolled face. The server verifies an active class-specific link, roster membership, and a location reported by the student's browser before recording attendance. Browser-provided GPS cannot by itself prove a student's physical presence against a determined spoofing attempt.
