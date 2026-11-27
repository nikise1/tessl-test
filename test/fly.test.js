import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Vector3 } from "three";
import { createFly } from "../src/fly.js";
import { load3DS } from "../src/load3ds.js";
import { CLUB, FLICK_HOLD, FLICK_IN, FLICK_OUT, flickPose } from "../src/tongue.js";

const file = new URL("../public/models/test_lizard_01.3ds", import.meta.url);
const bytes = fs.readFileSync(file);

function setup() {
  const loaded = load3DS(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  loaded.object.updateMatrixWorld(true);
  const { tongue } = loaded;
  const tip = tongue.bones[tongue.bones.length - 1];
  const home = new Vector3();
  tongue.setExtension(1);
  tip.getWorldPosition(home);
  tongue.setExtension(0);
  return { tongue, tip, fly: createFly(home) };
}

test("the fly buzzes near its home while the tongue is in the mouth", () => {
  const { tongue, tip, fly } = setup();
  for (let seconds = 0; seconds < 10; seconds += 0.1) {
    fly.update(seconds, tip, tongue.extension);
    assert.equal(fly.state, "flying");
    assert.ok(fly.group.visible);
    assert.ok(fly.group.position.distanceTo(fly.home) < fly.catchRadius, `at ${seconds.toFixed(1)}s`);
  }
});

test("a flick catches the fly, pulls it into the mouth and eats it", () => {
  const { tongue, tip, fly } = setup();
  const tipPoint = new Vector3();
  fly.update(0, tip, tongue.extension);
  const start = fly.group.position.clone();

  tongue.setExtension(1);
  fly.update(0.2, tip, tongue.extension);
  assert.equal(fly.state, "caught");

  // The fly rides inside the club back toward the mouth.
  tongue.setExtension(0.4);
  fly.update(0.4, tip, tongue.extension);
  tip.localToWorld(tipPoint.set(CLUB / 2, 0, 0));
  assert.equal(fly.state, "caught");
  assert.ok(fly.group.position.distanceTo(tipPoint) < 1e-6);
  assert.ok(fly.group.position.distanceTo(start) > 100);

  tongue.setExtension(0);
  fly.update(0.6, tip, tongue.extension);
  assert.equal(fly.state, "eaten");
  assert.equal(fly.group.visible, false);

  // A new fly turns up a moment later.
  fly.update(1.5, tip, tongue.extension);
  assert.equal(fly.state, "eaten");
  fly.update(4, tip, tongue.extension);
  assert.equal(fly.state, "flying");
  assert.ok(fly.group.visible);
  assert.ok(fly.group.position.distanceTo(fly.home) < fly.catchRadius);
});

test("a tongue that falls short does not catch the fly", () => {
  const { tongue, tip, fly } = setup();
  tongue.setExtension(0.5);
  fly.update(0.2, tip, tongue.extension);
  assert.equal(fly.state, "flying");
});

// Plays a flick the way the page does, 60 frames a second, starting at the
// given time, and says whether the fly was caught and eaten.
function playFlick(start) {
  const { tongue, tip, fly } = setup();
  let back = FLICK_OUT + FLICK_HOLD;
  let caughtAt = null;
  for (let frame = 0; frame < 120; frame += 1) {
    const seconds = frame / 60;
    if (fly.state === "caught" && seconds >= FLICK_OUT) back = Math.min(back, seconds);
    const pose = flickPose(seconds, back);
    tongue.setExtension(pose.extension);
    tongue.setWave(pose.wave, pose.phase);
    fly.update(start + seconds, tip, tongue.extension);
    tongue.setGrip(fly.state === "caught" ? 1 : 0);
    if (fly.state === "caught" && caughtAt === null) caughtAt = seconds;
    if (pose.done) break;
  }
  return { fly, tongue, caughtAt, back };
}

test("a flick catches the fly wherever it has buzzed to", () => {
  for (let start = 0; start < 12; start += 0.37) {
    const { fly, tongue, caughtAt, back } = playFlick(start);
    assert.notEqual(caughtAt, null, `missed the fly at ${start.toFixed(2)}s`);
    assert.equal(fly.state, "eaten", `at ${start.toFixed(2)}s`);
    // The tongue starts back as soon as it has the fly, not after the hold.
    assert.ok(back < FLICK_OUT + FLICK_HOLD, `pulled back at ${back.toFixed(2)}s`);
    assert.equal(tongue.grip, 0, "the club opens again once the fly is eaten");
    assert.equal(tongue.wave, 0, "the tongue ends straight");
  }
});

test("the tongue shoots out straight and ripples on the way back", () => {
  for (let seconds = 0; seconds < FLICK_OUT + FLICK_HOLD; seconds += 0.01) {
    assert.equal(flickPose(seconds).wave, 0, `bent at ${seconds.toFixed(2)}s`);
  }
  const back = FLICK_OUT + FLICK_HOLD;
  const middle = flickPose(back + FLICK_IN / 2);
  assert.ok(middle.wave > 0.9, `wave ${middle.wave}`);
  assert.ok(middle.extension > 0 && middle.extension < 1);
  assert.ok(flickPose(back + FLICK_IN).done);
  // An early catch brings the retraction forward.
  assert.ok(flickPose(FLICK_OUT + 0.05, FLICK_OUT).extension < 1);
});

test("a caught fly swings with the club as the tongue bends", () => {
  const { tongue, tip, fly } = setup();
  tongue.setExtension(1);
  fly.update(0, tip, tongue.extension);
  assert.equal(fly.state, "caught");
  const straight = fly.group.position.clone();
  const facing = fly.group.quaternion.clone();
  tongue.setWave(1, Math.PI / 2);
  fly.update(0.02, tip, tongue.extension);
  assert.ok(fly.group.position.distanceTo(straight) > 10, "the fly stays on the bent club");
  assert.ok(fly.group.quaternion.angleTo(facing) > 0.05, "the fly turns with the club");
});

test("the club closes around a catch and opens again", () => {
  const { tongue, tip } = setup();
  tongue.setGrip(1);
  assert.equal(tongue.grip, 1);
  assert.ok(tip.scale.x < 1 && tip.scale.y > 1 && tip.scale.z > 1);
  tongue.setGrip(0);
  assert.deepEqual(tip.scale.toArray(), [1, 1, 1]);
});
