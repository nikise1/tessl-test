import {
  Bone,
  BufferAttribute,
  LatheGeometry,
  MeshStandardMaterial,
  Skeleton,
  SkinnedMesh,
  Vector2,
} from "three";

// The 3DS file has no tongue, so this one is built in code. It hangs off the
// lower jaw (Bip01 Bott) and follows the jaw through the clip. The jaw's +x
// runs from the mouth corner to the chin; the upper jaw sits at -y.
const ROOT = [12, -17, 0];
// Aim between the two jaw tips (Bip01 Pony and Bip01 Pon0), out of the mouth.
const PITCH = Math.atan2(-7, 48);
// Shaft from the root to the club, then the sticky club at the tip.
const SHAFT = 32;
const CLUB = 10;
// At full extension the club is this far past its rest position.
const REACH = 220;

function profile() {
  const points = [];
  const steps = 24;
  for (let i = 0; i <= steps; i += 1) {
    const x = (i / steps) * SHAFT;
    points.push(new Vector2(4.2 - (x / SHAFT) * 1.4, x));
  }
  const clubSteps = 10;
  for (let i = 1; i <= clubSteps; i += 1) {
    const t = i / clubSteps;
    // The club swells past the shaft and closes to a point at the tip.
    points.push(new Vector2(Math.max(2.8 * (1 - t), 5.5 * Math.sin(Math.PI * t)), SHAFT + t * CLUB));
  }
  return points;
}

function tongueGeometry() {
  const geometry = new LatheGeometry(profile(), 14);
  // Lathe runs along +y. Turn it so the tongue runs along the root bone's +x.
  geometry.rotateZ(-Math.PI / 2);
  const position = geometry.attributes.position;
  const skinIndex = new Uint16Array(position.count * 4);
  const skinWeight = new Float32Array(position.count * 4);
  for (let i = 0; i < position.count; i += 1) {
    // Shaft weights blend linearly from root to tip, so moving the tip bone
    // stretches the shaft evenly. The club rides the tip bone and keeps its shape.
    const tip = Math.min(1, Math.max(0, position.getX(i) / SHAFT));
    skinIndex[i * 4] = 0;
    skinIndex[i * 4 + 1] = 1;
    skinWeight[i * 4] = 1 - tip;
    skinWeight[i * 4 + 1] = tip;
  }
  geometry.setAttribute("skinIndex", new BufferAttribute(skinIndex, 4));
  geometry.setAttribute("skinWeight", new BufferAttribute(skinWeight, 4));
  return geometry;
}

export function addTongue(jaw) {
  const root = new Bone();
  root.name = "Tongue";
  root.position.set(ROOT[0], ROOT[1], ROOT[2]);
  root.rotation.z = PITCH;
  const tip = new Bone();
  tip.name = "Tongue Tip";
  tip.position.set(SHAFT, 0, 0);
  root.add(tip);
  [root, tip].forEach((bone) => {
    bone.userData.deform = true;
  });

  const mesh = new SkinnedMesh(
    tongueGeometry(),
    new MeshStandardMaterial({ color: 0xd65c6e, roughness: 0.42, metalness: 0 }),
  );
  mesh.name = "tongue";
  mesh.position.copy(root.position);
  mesh.quaternion.copy(root.quaternion);
  mesh.frustumCulled = false;
  jaw.add(root, mesh);
  jaw.updateMatrixWorld(true);
  mesh.bind(new Skeleton([root, tip]));

  let extension = 0;
  return {
    mesh,
    bones: [root, tip],
    reach: REACH,
    get extension() {
      return extension;
    },
    // 0 keeps the tongue in the mouth, 1 shoots the club out by REACH.
    setExtension(value) {
      extension = Math.min(1, Math.max(0, Number(value) || 0));
      tip.position.x = SHAFT + extension * REACH;
      tip.updateMatrixWorld(true);
    },
  };
}
