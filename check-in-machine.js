"use strict";

const transitions = {
  loading: ["ready", "expired"],
  ready: ["looking-up", "expired"],
  "looking-up": ["looking-up", "ready", "student-found", "expired"],
  "student-found": ["ready", "looking-up", "checking-location", "expired"],
  "checking-location": ["ready", "student-found", "location-confirmed", "expired"],
  "location-confirmed": ["ready", "looking-up", "opening-camera", "expired"],
  "opening-camera": ["ready", "location-confirmed", "photo-captured", "camera-ready", "expired"],
  "camera-ready": ["ready", "location-confirmed", "photo-captured", "expired"],
  "photo-captured": ["ready", "looking-up", "opening-camera", "submitting", "expired"],
  submitting: ["photo-captured", "complete", "expired"],
  complete: [],
  expired: []
};
Object.values(transitions).forEach(Object.freeze);
Object.freeze(transitions);

function transition(current, next) {
  if (!transitions[current]?.includes(next)) {
    throw new Error(`Invalid student check-in transition: ${current} -> ${next}.`);
  }
  return next;
}

const machine = Object.freeze({ transitions, transition });

if (typeof module !== "undefined" && module.exports) {
  module.exports = machine;
} else {
  window.PresenceCheckInMachine = machine;
}
