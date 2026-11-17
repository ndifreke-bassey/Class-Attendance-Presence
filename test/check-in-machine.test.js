"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const machine = require("../check-in-machine");

test("student check-in defines the complete lifecycle and terminal states", () => {
  assert.deepEqual(Object.keys(machine.transitions), [
    "loading",
    "ready",
    "looking-up",
    "student-found",
    "checking-location",
    "location-confirmed",
    "opening-camera",
    "camera-ready",
    "photo-captured",
    "submitting",
    "complete",
    "expired"
  ]);
  assert.deepEqual(machine.transitions.complete, []);
  assert.deepEqual(machine.transitions.expired, []);
  assert.throws(() => machine.transitions.ready.push("complete"), TypeError);
});

test("student check-in permits the normal flow and retry paths", () => {
  const normalFlow = [
    "loading",
    "ready",
    "looking-up",
    "student-found",
    "checking-location",
    "location-confirmed",
    "opening-camera",
    "camera-ready",
    "photo-captured",
    "submitting",
    "complete"
  ];
  assert.equal(normalFlow.slice(1).reduce(machine.transition, normalFlow[0]), "complete");

  assert.equal(machine.transition("checking-location", "student-found"), "student-found");
  assert.equal(machine.transition("opening-camera", "location-confirmed"), "location-confirmed");
  assert.equal(machine.transition("submitting", "photo-captured"), "photo-captured");
  assert.equal(machine.transition("ready", "expired"), "expired");
  assert.equal(machine.transition("camera-ready", "expired"), "expired");
});

test("student check-in rejects out-of-order transitions", () => {
  for (const [current, next] of [
    ["loading", "complete"],
    ["ready", "submitting"],
    ["student-found", "photo-captured"],
    ["complete", "ready"],
    ["expired", "looking-up"]
  ]) {
    assert.throws(() => machine.transition(current, next), /Invalid student check-in transition/);
  }
});
