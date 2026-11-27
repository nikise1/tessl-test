import {
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from "three";

// The fly buzzes around a home point within reach of the tongue. When the club
// at the tongue tip comes within CATCH of it, the fly sticks to the club, rides
// it back into the mouth and is eaten. A new fly turns up RESPAWN seconds later.
const CATCH = 20;
const RESPAWN = 2.5;
// How far the fly wanders from home. Its farthest point is under CATCH away,
// so a full flick always reaches it while the lizard holds its rest pose.
const BUZZ = [12, 6, 12];
// The tongue counts as back in the mouth below this extension.
const SWALLOWED = 0.05;

function flyMesh() {
  const group = new Group();
  group.name = "fly";
  const dark = new MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.35, metalness: 0.2 });
  const eye = new MeshStandardMaterial({ color: 0x8a1c1c, roughness: 0.3, metalness: 0 });
  const wing = new MeshStandardMaterial({
    color: 0xd9e6f2,
    roughness: 0.2,
    metalness: 0,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });
  // The body runs along +z, so lookAt turns the fly to face where it flies.
  const body = new Mesh(new SphereGeometry(1, 16, 12), dark);
  body.scale.set(2.2, 2, 4);
  const head = new Mesh(new SphereGeometry(1.8, 14, 10), dark);
  head.position.z = 4.6;
  const eyes = [-1, 1].map((side) => {
    const mesh = new Mesh(new SphereGeometry(1.1, 12, 8), eye);
    mesh.position.set(side * 1.3, 0.6, 5.4);
    return mesh;
  });
  const wings = [-1, 1].map((side) => {
    const hinge = new Group();
    hinge.position.set(side * 1, 1.6, 0.8);
    const blade = new Mesh(new SphereGeometry(1, 12, 6), wing);
    blade.scale.set(3.4, 0.15, 1.6);
    blade.position.set(side * 3.2, 0, -1.4);
    hinge.add(blade);
    hinge.userData.side = side;
    return hinge;
  });
  group.add(body, head, ...eyes, ...wings);
  return { group, wings };
}

export function createFly(home) {
  const { group, wings } = flyMesh();
  const next = new Vector3();
  const tipPoint = new Vector3();
  let state = "flying";
  let eatenAt = 0;

  function buzzAt(seconds, out) {
    return out.set(
      home.x + Math.sin(seconds * 1.3) * BUZZ[0],
      home.y + Math.sin(seconds * 2.1 + 1) * BUZZ[1],
      home.z + Math.cos(seconds * 1.7) * BUZZ[2],
    );
  }

  return {
    group,
    home,
    catchRadius: CATCH,
    get state() {
      return state;
    },
    // Call once a frame with the time in seconds, the tongue's tip bone and its
    // extension (0 in the mouth, 1 at full reach).
    update(seconds, tip, extension) {
      const flap = Math.sin(seconds * 42) * 0.7;
      wings.forEach((hinge) => {
        hinge.rotation.z = hinge.userData.side * flap;
      });
      if (state === "eaten") {
        if (seconds - eatenAt < RESPAWN) return;
        state = "flying";
        group.visible = true;
      }
      if (tip) tip.getWorldPosition(tipPoint);
      if (state === "flying") {
        buzzAt(seconds, group.position);
        group.lookAt(buzzAt(seconds + 0.05, next));
        if (tip && extension > SWALLOWED && tipPoint.distanceTo(group.position) < CATCH) state = "caught";
      }
      if (state === "caught") {
        group.position.copy(tipPoint);
        if (extension <= SWALLOWED) {
          state = "eaten";
          eatenAt = seconds;
          group.visible = false;
        }
      }
    },
  };
}
