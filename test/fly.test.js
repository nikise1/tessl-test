import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Vector3 } from "three";
import { createFly } from "../src/fly.js";
import { load3DS } from "../src/load3ds.js";

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

  // The fly rides the club back toward the mouth.
  tongue.setExtension(0.4);
  fly.update(0.4, tip, tongue.extension);
  tip.getWorldPosition(tipPoint);
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
