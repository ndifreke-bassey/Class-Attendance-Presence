# Presence state machines

This inventory documents the stateful workflows currently implemented by the application. The student check-in sequence is enforced by `check-in-machine.js`; the other workflows are currently enforced by their server rules and page controllers and are listed here as behavioral contracts, not as claims that every transition is implemented by a shared state-machine framework.

## Student check-in

The page controller stores the current phase in one value and validates each phase change through `check-in-machine.js`. Student identity, location, and the camera stream remain data associated with the phase; they do not independently decide which step is available.

```text
loading -> ready -> looking-up -> student-found -> checking-location
                                           ^               |
                                           | failure       | confirmed
                                           +---------------v
                                      location-confirmed -> opening-camera -> camera-ready
                                             ^                    |               |
                                             | permission failed  |                | captured
                                             +--------------------+                v
                                                                     photo-captured -> submitting -> complete
                                                                          ^              |
                                                                          +-- retry -----+

Every nonterminal phase -> expired
complete and expired are terminal.
```

Changing the registration number resets the verification steps. Location and camera permission failures leave the student able to retry. Expiry stops active timers and camera tracks. Camera/photo capture remains a local user-presence step; it is not face identity matching.

## Lecturer portal

- **Authentication view:** boot/status check -> signed out (login or invitation activation) -> signed in -> lecturer dashboard. Authentication errors remain on the current form.
- **Dashboard/class:** no class -> class setup -> class selected; one or more classes -> selected class. A class can be edited only when it has no active attendance session. Roster add/remove is disabled while a session is active.
- **Attendance session:** none -> active -> closed by lecturer or expired by time. Only an active session accepts check-ins or expiry edits; the per-session management token authorizes changes. Refresh polling reconciles the browser view with server state.
- **Class editor:** closed -> create or edit (`editingCourse`) -> save or cancel. Class creation and edits are blocked while a session is active.
- **Roster:** current roster -> add or remove a student -> refresh. Removal is a soft deactivation so historic attendance remains reportable.
- **Report:** idle/date range -> preview -> export. Changing the range clears the preview; export is recorded in the audit log.
- **Background refresh:** idle -> refreshing -> updated or failed. The dashboard polls every five seconds, prevents overlapping refreshes, and rehydrates the session-management token from tab-scoped storage.
- **Dialogs and location setup:** closed -> open/editing -> saved or cancelled. Current-location lookup is a transient pending/succeeded/failed operation.
- **Feedback and share actions:** toast hidden/visible/timeout; invitation and recovery links exist in page memory only until navigation; clipboard operations can succeed or fail.

## Owner administration

- **Owner access:** status check -> sign-in -> dashboard, or sign-out. Owner-only endpoints reject lecturer and unauthenticated sessions.
- **Invitations:** issued/unused -> used on account activation, revoked by the owner, or expired by time. The code is shown only when issued and is stored as a hash.
- **Lecturer account:** active -> suspended -> reactivated. Suspension invalidates sessions and recovery links but retains records.
- **Password recovery:** issued -> used once or expired. Issuing another link replaces the existing recovery token.
- **Owner actions:** invitation creation, revocation, suspension, recovery-link creation, and dashboard refresh each have request-pending/succeeded/failed UI behavior.
- **Login throttling:** each client address accumulates failed attempts in a 15-minute window; after ten failures, sign-in is blocked until that window rolls over or a successful sign-in clears the counter.
- **Dashboard bootstrap:** status check -> dashboard data refresh -> authenticated view. A refresh error can leave the authenticated page on its prior view; this is one of the remaining implicit page-controller states.

## Student account recovery

Recovery link -> password form -> submitting -> completed, or validation/server error -> editable form. The token is removed from the URL after page load; a successful reset invalidates existing lecturer sessions.

## Other page-controller states

- **Lecturer sign-in/activation:** URL and invitation determine login versus activation; status lookup enables or blocks activation. Form submission and dashboard bootstrap are asynchronous, but not represented by one explicit page-level state.
- **Admin sign-in:** initial owner-status lookup -> signed out or authenticated dashboard; login and dashboard loading failures are shown in the corresponding error area.
- **Session management token:** absent or present in tab storage; when absent, an active session can still be displayed, but expiry edits and close actions are disabled.
- **Report preview, exports, corrections, roster mutations, and location lookup:** each has input validation followed by a request-pending/succeeded/failed UI path. Most pending states are represented by DOM/button state rather than a shared transition model.
- **Debounced student lookup:** idle -> waiting 250 ms -> request -> profile or error. Changing the registration number clears the prior profile and invalidates outstanding lookup/location work.

## Theme

Unconfigured preference -> device preference; explicit light/dark choice -> persisted browser preference. If browser storage is unavailable, the current page still changes theme but the choice cannot persist.

## Server lifecycle and records

- **Server process:** starting -> listening -> shutting down -> stopped; a bounded shutdown timeout prevents hanging indefinitely.
- **Lecturer/admin browser sessions:** authenticated -> logged out, revoked, or expired. Sessions currently live in process memory, so a server restart signs users out.
- **Attendance record:** absent -> recorded once per student/session -> corrected (removed with a reason and audit event). A duplicate submission is rejected.
- **Invitation and recovery tokens:** unissued -> issued -> consumed/revoked/expired. Their clear values are returned only at issuance.

## Known gaps and guardrails

- Check-in phases are the first machine enforced centrally and covered by unit tests. Do not introduce new check-in DOM visibility states without adding a phase or explaining why the state is orthogonal.
- Admin actions and the lecturer report/dialog flows still use button flags, DOM visibility, and request callbacks rather than explicit controllers. Keep their pending/error/success behavior in sync when extending them.
- Process-local login sessions and JSON-file persistence are single-process prototype choices; they are not appropriate for horizontal scaling or durable production authentication.
- Geolocation is browser-reported, and the selfie is not matched against an enrolled face. Neither currently proves identity or prevents a determined spoof.
