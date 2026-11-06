import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FPS, load3DS } from "./load3ds.js";

const canvas = document.querySelector("#view");
const fileLine = document.querySelector(".file");
const errorLine = document.querySelector("#error");
const transport = document.querySelector("#transport");
const ranges = document.querySelector("#ranges");
const toggles = document.querySelector("#toggles");
const hint = document.querySelector("#hint");
const sources = document.querySelector("#sources");
const sourcesBody = document.querySelector("#sources-body");
const playButton = document.querySelector("#play");
const pauseButton = document.querySelector("#pause");
const restartButton = document.querySelector("#restart");
const wireButton = document.querySelector("#wire");
const bonesButton = document.querySelector("#bones");
const flickButton = document.querySelector("#flick");
const tongueSlider = document.querySelector("#tongue");
const tongueWrap = document.querySelector("#tongue-wrap");
const scrub = document.querySelector("#scrub");
const scrubWrap = document.querySelector("#scrub-wrap");
const frameLabel = document.querySelector("#frame-label");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
camera.position.set(180, 120, 260);

scene.add(new THREE.AmbientLight(0xffffff, 0.72));
const key = new THREE.DirectionalLight(0xfff7ee, 2.4);
key.position.set(1.2, 1.6, 1.4);
scene.add(key);
const fill = new THREE.DirectionalLight(0xd7ecff, 1.15);
fill.position.set(-1.4, 0.4, -0.8);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xc8ffcf, 0.7);
rim.position.set(-0.2, 0.8, -1.6);
scene.add(rim);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);

const clock = new THREE.Clock();
let mixer = null;
let action = null;
let meta = null;
let skin = null;
let model = null;
let playing = false;
let skeletonLines = null;
let skeletonPairs = [];
const solidColor = new THREE.Color(0x3cae45);
const wireColor = new THREE.Color(0xdfffe4);
const textureColor = new THREE.Color(0xffffff);
let skinMap = null;
let skinNormal = null;
let skinRoughness = null;
let tongue = null;
let flickStart = null;
// One flick: the tongue shoots out, holds a moment, and pulls back in.
const FLICK_OUT = 0.12;
const FLICK_HOLD = 0.18;
const FLICK_IN = 0.45;

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
}

function frameModel() {
  const box = new THREE.Box3().setFromObject(skin || model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 1);
  const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2;
  const distance = (radius * 0.62) / Math.tan(halfFov);
  const offset = new THREE.Vector3(0.72, 0.38, 1).normalize().multiplyScalar(distance);
  camera.position.copy(center).add(offset);
  camera.near = Math.max(distance / 300, 0.05);
  camera.far = distance * 40;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.minDistance = distance * 0.15;
  controls.maxDistance = distance * 6;
  controls.update();
}

function currentFrame() {
  if (!mixer) return 0;
  return Math.round(mixer.time * FPS);
}

function setFrame(frame) {
  if (!mixer || !action) return;
  const end = meta?.frameEnd ?? 200;
  const clamped = Math.min(end, Math.max(0, frame));
  // A paused action ignores mixer.setTime, so apply the pose first, then pause.
  action.paused = false;
  action.play();
  mixer.setTime(clamped / FPS);
  action.paused = true;
  playing = false;
  syncControls();
}

function syncControls() {
  const frame = currentFrame();
  const end = meta?.frameEnd ?? 200;
  frameLabel.textContent = `Frame ${frame}`;
  if (document.activeElement !== scrub) scrub.value = String(frame);
  playButton.disabled = playing;
  pauseButton.disabled = !playing;
  ranges.querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.active === "true" ? "true" : "false");
  });
}

function playFrom(frame) {
  if (!action || !mixer) return;
  const end = meta.frameEnd;
  const startAt = frame >= end ? 0 : frame;
  action.reset();
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.clampWhenFinished = false;
  action.enabled = true;
  action.paused = false;
  action.play();
  mixer.setTime(startAt / FPS);
  playing = true;
  ranges.querySelectorAll("button").forEach((button) => {
    button.dataset.active = "true";
  });
  syncControls();
}

function show(element) {
  element.hidden = false;
}

function setSources(info, textureState = "loading") {
  fileLine.innerHTML = `Loaded <code>${info.sourceFile}</code> · three.js r${THREE.REVISION}`;
  const textureNote =
    textureState === "loaded"
      ? `The skin is a 2048² green chameleon map (${info.textureFile}) with a soft mouth interior, quieter color on the feet, throat, and tail tip, and matching normal and roughness maps, in place of the original 256² ${info.sourceTexture}.`
      : textureState === "missing"
        ? `The chameleon texture ${info.textureFile} could not be loaded, so the body uses a flat green.`
        : `The chameleon skin texture ${info.textureFile} is loading.`;
  sourcesBody.textContent = `${info.sourceFile} is on screen: the lizard mesh, the Character Studio biped (${info.deformBones} joints), and one keyframe clip named ${info.animationName} (frames ${info.frameStart}–${info.frameEnd} at ${info.fps} fps). ${info.staticFile} is a static Wavefront skin of the same animal and has no animation, so it is not loaded. three.js TDSLoader does not read 3DS keyframes, so this page parses that chunk itself. The skin was exported without vertex weights; it is bound onto the biped so the clip can deform it. The tongue is not in the 3DS file: it is built in code on two extra bones under the lower jaw (Bip01 Bott), and its tip bone slides out to grow it and back to shrink it. ${textureNote}`;
}

function paintSkin() {
  if (!skin) return;
  const wire = wireButton.getAttribute("aria-pressed") === "true";
  skin.material.wireframe = wire;
  const textured = Boolean(skinMap) && !wire;
  skin.material.map = textured ? skinMap : null;
  skin.material.normalMap = textured ? skinNormal : null;
  skin.material.roughnessMap = textured ? skinRoughness : null;
  skin.material.roughness = textured && skinRoughness ? 1 : 0.58;
  skin.material.color.copy(textured ? textureColor : wire ? wireColor : solidColor);
  skin.material.needsUpdate = true;
}

function prepareTexture(texture, colorSpace) {
  texture.colorSpace = colorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // 3DS UVs use the OpenGL origin (v = 0 at the bottom). flipY keeps the
  // atlas upright against that convention.
  texture.flipY = true;
  return texture;
}

const asset = (path) => `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;

function loadSkinTexture(info) {
  const loader = new THREE.TextureLoader();
  loader.load(
    asset(`models/${info.textureFile}`),
    (texture) => {
      skinMap = prepareTexture(texture, THREE.SRGBColorSpace);
      paintSkin();
      setSources(info, "loaded");
    },
    undefined,
    () => setSources(info, "missing"),
  );
  if (info.normalFile) {
    loader.load(asset(`models/${info.normalFile}`), (texture) => {
      skinNormal = prepareTexture(texture, THREE.NoColorSpace);
      paintSkin();
    });
  }
  if (info.roughnessFile) {
    loader.load(asset(`models/${info.roughnessFile}`), (texture) => {
      skinRoughness = prepareTexture(texture, THREE.NoColorSpace);
      paintSkin();
    });
  }
}

function buildSkeletonLines(bones) {
  const pairs = [];
  bones.forEach((bone) => {
    if (bone.parent?.userData?.deform) pairs.push(bone.parent, bone);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pairs.length * 3), 3));
  const lines = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color: 0xd8ffb0, depthTest: false }),
  );
  lines.frustumCulled = false;
  lines.visible = false;
  lines.renderOrder = 2;
  scene.add(lines);
  skeletonLines = lines;
  skeletonPairs = pairs;
}

const skeletonPoint = new THREE.Vector3();

function updateSkeletonLines() {
  if (!skeletonLines?.visible) return;
  const attribute = skeletonLines.geometry.attributes.position;
  skeletonPairs.forEach((bone, index) => {
    bone.getWorldPosition(skeletonPoint);
    attribute.setXYZ(index, skeletonPoint.x, skeletonPoint.y, skeletonPoint.z);
  });
  attribute.needsUpdate = true;
}

function setTongue(value) {
  if (!tongue) return;
  tongue.setExtension(value);
  tongueSlider.value = String(tongue.extension);
}

function flickAt(seconds) {
  if (seconds < FLICK_OUT) return seconds / FLICK_OUT;
  if (seconds < FLICK_OUT + FLICK_HOLD) return 1;
  const back = (seconds - FLICK_OUT - FLICK_HOLD) / FLICK_IN;
  return back >= 1 ? 0 : 1 - back * back * (3 - 2 * back);
}

function updateFlick() {
  if (flickStart === null) return;
  const seconds = (performance.now() - flickStart) / 1000;
  setTongue(flickAt(seconds));
  if (seconds >= FLICK_OUT + FLICK_HOLD + FLICK_IN) flickStart = null;
}

async function main() {
  resize();
  const response = await fetch(asset("models/test_lizard_01.3ds"));
  if (!response.ok) throw new Error(`Could not fetch the 3DS file (${response.status})`);
  const buffer = await response.arrayBuffer();
  const loaded = load3DS(buffer);
  meta = loaded.meta;
  skin = loaded.skin;
  tongue = loaded.tongue;
  model = new THREE.Group();
  // 3DS is Z-up. Rotate the whole scene so the biped's up axis is Y.
  model.rotation.x = -Math.PI / 2;
  model.add(loaded.object);
  scene.add(model);
  model.updateMatrixWorld(true);

  buildSkeletonLines(tongue ? [...loaded.bones, ...tongue.bones] : loaded.bones);
  mixer = new THREE.AnimationMixer(loaded.object);
  action = mixer.clipAction(loaded.clip);
  action.play();
  action.paused = true;
  mixer.setTime(0);

  scrub.max = String(meta.frameEnd);
  const segments = [
    { label: "MAXSCENE", start: 0, end: meta.frameEnd },
  ];
  segments.forEach((segment) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = segment.label;
    button.dataset.start = String(segment.start);
    button.dataset.end = String(segment.end);
    button.dataset.active = "false";
    button.addEventListener("click", () => playFrom(segment.start));
    ranges.append(button);
  });

  show(transport);
  show(ranges);
  show(toggles);
  show(hint);
  show(sources);
  show(scrubWrap);
  if (tongue) show(tongueWrap);
  else flickButton.hidden = true;
  setSources(meta);
  loadSkinTexture(meta);
  frameModel();
  const params = new URLSearchParams(window.location.search);
  if (params.get("wire") === "1") wireButton.click();
  if (params.get("bones") === "1") bonesButton.click();
  if (params.has("tongue")) setTongue(Number(params.get("tongue")));
  if (params.has("frame")) setFrame(Number(params.get("frame")));
  else if (params.get("play") === "1") playFrom(0);
  syncControls();

  window.__lizard = {
    meta,
    setFrame,
    play: () => playFrom(0),
    pause: () => setFrame(currentFrame()),
    frame: currentFrame,
    camera,
    controls,
    skin,
    tongue,
    setTongue,
    flick: () => flickButton.click(),
    scene,
  };
}

playButton.addEventListener("click", () => {
  if (!meta) return;
  playFrom(currentFrame());
});
pauseButton.addEventListener("click", () => setFrame(currentFrame()));
restartButton.addEventListener("click", () => {
  setFrame(0);
});
wireButton.addEventListener("click", () => {
  if (!skin) return;
  const on = wireButton.getAttribute("aria-pressed") !== "true";
  wireButton.setAttribute("aria-pressed", on ? "true" : "false");
  paintSkin();
});
bonesButton.addEventListener("click", () => {
  const on = bonesButton.getAttribute("aria-pressed") !== "true";
  bonesButton.setAttribute("aria-pressed", on ? "true" : "false");
  if (skeletonLines) skeletonLines.visible = on;
  updateSkeletonLines();
});
flickButton.addEventListener("click", () => {
  if (!tongue) return;
  flickStart = performance.now();
});
tongueSlider.addEventListener("input", () => {
  flickStart = null;
  setTongue(Number(tongueSlider.value));
});
scrub.addEventListener("input", () => setFrame(Number(scrub.value)));
window.addEventListener("resize", resize);
window.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.target instanceof HTMLInputElement) return;
  event.preventDefault();
  if (playing) pauseButton.click();
  else playButton.click();
});

function tick() {
  const delta = clock.getDelta();
  if (mixer && playing) mixer.update(delta);
  updateFlick();
  controls.update();
  updateSkeletonLines();
  if (mixer) syncControls();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

main().catch((error) => {
  console.error(error);
  errorLine.hidden = false;
  errorLine.textContent = error.message || String(error);
});
tick();
