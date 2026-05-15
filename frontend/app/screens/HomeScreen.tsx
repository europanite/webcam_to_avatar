import React, { useEffect, useRef, useState } from "react";
import {
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import { VRM, VRMUtils, VRMLoaderPlugin } from "@pixiv/three-vrm";
import * as Kalidokit from "kalidokit";

const VIDEO_WIDTH = 480;
const VIDEO_HEIGHT = 640;
const DEFAULT_MIRROR_AVATAR_POSE = true;

interface ThreeContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  clock: THREE.Clock;
}

interface UiStatus {
  camera: string;
  pose: string;
  tracking: string;
  vrm: string;
  error?: string;
}

type EulerRotation = {
  x?: number;
  y?: number;
  z?: number;
};

type SolvedPose = {
  Hips?: { rotation?: EulerRotation; position?: EulerRotation };
  Spine?: EulerRotation;
  Chest?: EulerRotation;
  Neck?: EulerRotation;
  Head?: EulerRotation;
  LeftUpperArm?: EulerRotation;
  LeftLowerArm?: EulerRotation;
  LeftHand?: EulerRotation;
  RightUpperArm?: EulerRotation;
  RightLowerArm?: EulerRotation;
  RightHand?: EulerRotation;
  LeftUpperLeg?: EulerRotation;
  LeftLowerLeg?: EulerRotation;
  LeftFoot?: EulerRotation;
  RightUpperLeg?: EulerRotation;
  RightLowerLeg?: EulerRotation;
  RightFoot?: EulerRotation;
};

type MediaPipeLandmark = {
  x: number;
  y: number;
  z: number;
  visibility?: number;
  presence?: number;
  score?: number;
};

type PosePoint = {
  x: number;
  y: number;
  z: number;
  score: number;
};

type PosePerson = {
  keypoints: Record<string, PosePoint | null>;
  mediapipeLandmarks?: MediaPipeLandmark[];
  mediapipeWorldLandmarks?: MediaPipeLandmark[];
};

type AvatarSceneMetrics = {
  height: number;
  groundY: number;
};

type WorldSkeletonContext = {
  landmarks: MediaPipeLandmark[];
  origin: MediaPipeLandmark;
  ySign: 1 | -1;
  scale: number;
  yOffset: number;
};

type DebugDisplaySettings = {
  showWebcamBones: boolean;
  showEstimatedBones: boolean;
  showVrmSkeleton: boolean;
  mirrorAvatarPose: boolean;
};

const VRM_BONE_NAMES = {
  hips: "hips",
  spine: "spine",
  chest: "chest",
  upperChest: "upperChest",
  neck: "neck",
  head: "head",
  leftUpperArm: "leftUpperArm",
  leftLowerArm: "leftLowerArm",
  leftHand: "leftHand",
  rightUpperArm: "rightUpperArm",
  rightLowerArm: "rightLowerArm",
  rightHand: "rightHand",
  leftUpperLeg: "leftUpperLeg",
  leftLowerLeg: "leftLowerLeg",
  leftFoot: "leftFoot",
  rightUpperLeg: "rightUpperLeg",
  rightLowerLeg: "rightLowerLeg",
  rightFoot: "rightFoot",
} as const;

const BODY25_TO_MEDIAPIPE: Record<string, number | null> = {
  Nose: 0,
  Neck: null,
  RShoulder: 12,
  RElbow: 14,
  RWrist: 16,
  LShoulder: 11,
  LElbow: 13,
  LWrist: 15,
  MidHip: null,
  RHip: 24,
  RKnee: 26,
  RAnkle: 28,
  LHip: 23,
  LKnee: 25,
  LAnkle: 27,
  REye: 5,
  LEye: 2,
  REar: 8,
  LEar: 7,
  LBigToe: 31,
  LSmallToe: null,
  LHeel: 29,
  RBigToe: 32,
  RSmallToe: null,
  RHeel: 30,
};

const BODY25_TO_MEDIAPIPE_WORLD: Record<string, number | null> = {
  ...BODY25_TO_MEDIAPIPE,
  Neck: null,
  MidHip: null,
};

const BODY25_BONES: Array<[string, string]> = [
  ["Neck", "RShoulder"],
  ["RShoulder", "RElbow"],
  ["RElbow", "RWrist"],
  ["Neck", "LShoulder"],
  ["LShoulder", "LElbow"],
  ["LElbow", "LWrist"],
  ["Neck", "MidHip"],
  ["MidHip", "RHip"],
  ["RHip", "RKnee"],
  ["RKnee", "RAnkle"],
  ["MidHip", "LHip"],
  ["LHip", "LKnee"],
  ["LKnee", "LAnkle"],
  ["Neck", "Nose"],
  ["Nose", "REye"],
  ["REye", "REar"],
  ["Nose", "LEye"],
  ["LEye", "LEar"],
];

const FOOT_BODY25_NAMES = ["LAnkle", "RAnkle", "LHeel", "RHeel", "LBigToe", "RBigToe"];
const TOP_BODY25_NAMES = ["Nose", "LEye", "REye", "LEar", "REar"];
const DEFAULT_AVATAR_GROUND_Y = -1.05;
const DEFAULT_AVATAR_HEIGHT = 2.05;
const ESTIMATED_BONE_TORSO_HEIGHT_FALLBACK = 0.95;
const ESTIMATED_BONE_WORLD_X_SIGN = -1;

async function loadPoseFromCdn(): Promise<any> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("MediaPipe Pose can only be loaded in a browser environment");
  }

  const existing = (window as any).Pose;
  if (existing) return existing;

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5/pose.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = (err) => reject(err);
    document.head.appendChild(script);
  });

  const PoseCtor = (window as any).Pose;
  if (!PoseCtor) {
    throw new Error("Failed to load MediaPipe Pose from CDN");
  }
  return PoseCtor;
}

async function loadCameraUtilsFromCdn(): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if ((window as any).Camera) return;

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3/camera_utils.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = (err) => reject(err);
    document.head.appendChild(script);
  });
}

function asLandmarkArray(landmarks: any): MediaPipeLandmark[] | null {
  if (!landmarks || typeof landmarks.length !== "number") return null;

  const converted: MediaPipeLandmark[] = [];
  for (let i = 0; i < landmarks.length; i += 1) {
    const lm = landmarks[i];
    if (!lm || typeof lm.x !== "number" || typeof lm.y !== "number" || typeof lm.z !== "number") {
      return null;
    }
    converted.push({
      x: lm.x,
      y: lm.y,
      z: lm.z,
      visibility: typeof lm.visibility === "number" ? lm.visibility : undefined,
      presence: typeof lm.presence === "number" ? lm.presence : undefined,
      score: typeof lm.visibility === "number" ? lm.visibility : 1,
    });
  }

  return converted;
}

function isValidLandmarkArray(landmarks: any, expectedLength: number): landmarks is MediaPipeLandmark[] {
  const array = asLandmarkArray(landmarks);
  if (!array || array.length < expectedLength) return false;

  for (let i = 0; i < expectedLength; i += 1) {
    const lm = array[i];
    if (
      !Number.isFinite(lm.x) ||
      !Number.isFinite(lm.y) ||
      !Number.isFinite(lm.z)
    ) {
      return false;
    }
  }

  return true;
}

function isVisibleLandmark(point: MediaPipeLandmark | null | undefined) {
  if (!point) return false;
  const score = point.score ?? point.visibility ?? 1;
  return score >= 0.2;
}

function averageLandmarks(landmarks: MediaPipeLandmark[], indices: number[]): MediaPipeLandmark | null {
  const points = indices.map((idx) => landmarks[idx]).filter(isVisibleLandmark);
  if (points.length === 0) return null;

  const inv = 1 / points.length;
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) * inv,
    y: points.reduce((sum, point) => sum + point.y, 0) * inv,
    z: points.reduce((sum, point) => sum + point.z, 0) * inv,
    visibility: Math.min(...points.map((point) => point.visibility ?? point.score ?? 1)),
    score: Math.min(...points.map((point) => point.score ?? point.visibility ?? 1)),
  };
}

function landmarkToPosePoint(point: MediaPipeLandmark): PosePoint {
  return {
    x: point.x,
    y: point.y,
    z: point.z,
    score: point.visibility ?? point.score ?? 1,
  };
}

function getBody25Landmark(landmarks: MediaPipeLandmark[], name: string): MediaPipeLandmark | null {
  if (name === "Neck") return averageLandmarks(landmarks, [11, 12]);
  if (name === "MidHip") return averageLandmarks(landmarks, [23, 24]);

  const index = BODY25_TO_MEDIAPIPE[name];
  if (index == null) return null;

  const point = landmarks[index];
  return isVisibleLandmark(point) ? point : null;
}

function webcamResultsToPosePerson(results: any): PosePerson | null {
  const pose2D = asLandmarkArray(results.poseLandmarks);
  const poseWorld = asLandmarkArray(results.poseWorldLandmarks);

  if (!pose2D || pose2D.length < 33) return null;

  const keypoints: Record<string, PosePoint | null> = {};
  for (const name of Object.keys(BODY25_TO_MEDIAPIPE)) {
    const point = getBody25Landmark(pose2D, name);
    keypoints[name] = point ? landmarkToPosePoint(point) : null;
  }

  return {
    keypoints,
    mediapipeLandmarks: pose2D,
    mediapipeWorldLandmarks: poseWorld && poseWorld.length >= 33 ? poseWorld : undefined,
  };
}

function hasMediaPipeLandmarks(person: PosePerson | null): person is PosePerson & {
  mediapipeLandmarks: MediaPipeLandmark[];
  mediapipeWorldLandmarks: MediaPipeLandmark[];
} {
  return Boolean(
    person &&
      isValidLandmarkArray(person.mediapipeLandmarks, 33) &&
      isValidLandmarkArray(person.mediapipeWorldLandmarks, 33)
  );
}

function applyRotation(vrm: VRM, boneName: string, rotation?: EulerRotation, dampener = 1.0) {
  if (!rotation) return;

  const bone = vrm.humanoid.getNormalizedBoneNode(boneName as never);
  if (!bone) return;

  bone.rotation.set(
    (rotation.x ?? 0) * dampener,
    (rotation.y ?? 0) * dampener,
    (rotation.z ?? 0) * dampener,
    "XYZ"
  );
}

function applyHips(vrm: VRM, solvedPose: SolvedPose) {
  if (!solvedPose.Hips) return;

  // Same as pose_estimation/frontend/src/AvatarRigKalidokit.tsx:
  // keep the loaded VRM root fixed and apply only local hips rotation.
  applyRotation(vrm, VRM_BONE_NAMES.hips, solvedPose.Hips.rotation, 0.35);
}

function applySolvedPose(vrm: VRM, solvedPose: SolvedPose) {
  applyHips(vrm, solvedPose);

  applyRotation(vrm, VRM_BONE_NAMES.spine, solvedPose.Spine, 0.35);
  applyRotation(vrm, VRM_BONE_NAMES.chest, solvedPose.Chest ?? solvedPose.Spine, 0.25);
  applyRotation(vrm, VRM_BONE_NAMES.upperChest, solvedPose.Chest ?? solvedPose.Spine, 0.2);
  applyRotation(vrm, VRM_BONE_NAMES.neck, solvedPose.Neck, 0.35);
  applyRotation(vrm, VRM_BONE_NAMES.head, solvedPose.Head, 0.5);

  applyRotation(vrm, VRM_BONE_NAMES.leftUpperArm, solvedPose.LeftUpperArm, 1.0);
  applyRotation(vrm, VRM_BONE_NAMES.leftLowerArm, solvedPose.LeftLowerArm, 1.0);
  applyRotation(vrm, VRM_BONE_NAMES.leftHand, solvedPose.LeftHand, 0.7);
  applyRotation(vrm, VRM_BONE_NAMES.rightUpperArm, solvedPose.RightUpperArm, 1.0);
  applyRotation(vrm, VRM_BONE_NAMES.rightLowerArm, solvedPose.RightLowerArm, 1.0);
  applyRotation(vrm, VRM_BONE_NAMES.rightHand, solvedPose.RightHand, 0.7);

  applyRotation(vrm, VRM_BONE_NAMES.leftUpperLeg, solvedPose.LeftUpperLeg, 0.8);
  applyRotation(vrm, VRM_BONE_NAMES.leftLowerLeg, solvedPose.LeftLowerLeg, 0.8);
  applyRotation(vrm, VRM_BONE_NAMES.leftFoot, solvedPose.LeftFoot, 0.6);
  applyRotation(vrm, VRM_BONE_NAMES.rightUpperLeg, solvedPose.RightUpperLeg, 0.8);
  applyRotation(vrm, VRM_BONE_NAMES.rightLowerLeg, solvedPose.RightLowerLeg, 0.8);
  applyRotation(vrm, VRM_BONE_NAMES.rightFoot, solvedPose.RightFoot, 0.6);

  vrm.humanoid.update();
}

function applyPoseEstimationKalidokitToVrm(vrm: VRM, person: PosePerson | null): boolean {
  if (!hasMediaPipeLandmarks(person)) return false;

  const solvedPose = Kalidokit.Pose.solve(
    person.mediapipeWorldLandmarks,
    person.mediapipeLandmarks,
    {
      runtime: "mediapipe",
      enableLegs: true,
    }
  ) as SolvedPose | null;

  if (!solvedPose) return false;

  vrm.humanoid.resetNormalizedPose();
  applySolvedPose(vrm, solvedPose);
  return true;
}

function measureAvatarScene(scene: THREE.Object3D): AvatarSceneMetrics | null {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  if (!Number.isFinite(box.min.y) || !Number.isFinite(box.max.y) || box.isEmpty()) {
    return null;
  }

  const height = box.max.y - box.min.y;
  if (height <= 1e-5) return null;

  return { height, groundY: box.min.y };
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();

    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach((m) => m.dispose());
    } else if (material) {
      material.dispose();
    }
  });
}

function setupThree(canvas: HTMLCanvasElement): ThreeContext {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setSize(VIDEO_WIDTH, VIDEO_HEIGHT);
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(
    33,
    VIDEO_WIDTH / VIDEO_HEIGHT,
    0.1,
    2000
  );
  camera.position.set(0, 0.25, 3.6);
  camera.lookAt(new THREE.Vector3(0, 0.15, 0));
  scene.add(camera);

  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(3, 5, 4);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));

  const clock = new THREE.Clock();

  return { renderer, scene, camera, clock };
}

function createLineSegments(color: number) {
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.LineBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
  });
  const line = new THREE.LineSegments(geometry, material);
  line.renderOrder = 10000;
  line.frustumCulled = false;
  return line;
}

function updateLineSegments(line: THREE.LineSegments, segments: Array<[THREE.Vector3, THREE.Vector3]>) {
  const positions = new Float32Array(segments.length * 2 * 3);

  segments.forEach(([from, to], index) => {
    positions.set([from.x, from.y, from.z, to.x, to.y, to.z], index * 6);
  });

  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry();
  line.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  line.geometry.computeBoundingSphere();
}

function disposeSkeletonHelper(helper: THREE.SkeletonHelper) {
  helper.geometry.dispose();
  const material = helper.material;
  if (Array.isArray(material)) {
    material.forEach((m) => m.dispose());
  } else {
    material.dispose();
  }
}

function toRawVrmVector(point: MediaPipeLandmark, origin: MediaPipeLandmark, ySign: 1 | -1) {
  return new THREE.Vector3(
    (point.x - origin.x) * ESTIMATED_BONE_WORLD_X_SIGN,
    (point.y - origin.y) * ySign,
    point.z - origin.z
  );
}

function rawY(point: MediaPipeLandmark, origin: MediaPipeLandmark, ySign: 1 | -1) {
  return (point.y - origin.y) * ySign;
}

function getWorldLandmarkForBody25(landmarks: MediaPipeLandmark[], name: string): MediaPipeLandmark | null {
  if (name === "Neck") return averageLandmarks(landmarks, [11, 12]);
  if (name === "MidHip") return averageLandmarks(landmarks, [23, 24]);

  const index = BODY25_TO_MEDIAPIPE_WORLD[name];
  if (index == null) return null;

  const point = landmarks[index];
  return isVisibleLandmark(point) ? point : null;
}

function collectVisibleWorldPoints(landmarks: MediaPipeLandmark[], names: string[]) {
  return names
    .map((name) => getWorldLandmarkForBody25(landmarks, name))
    .filter(isVisibleLandmark);
}

function buildWorldSkeletonContext(
  person: PosePerson,
  avatarMetrics: AvatarSceneMetrics | null
): WorldSkeletonContext | null {
  if (!person.mediapipeWorldLandmarks?.length) return null;

  const landmarks = person.mediapipeWorldLandmarks;
  const midHip = getWorldLandmarkForBody25(landmarks, "MidHip");
  const neck = getWorldLandmarkForBody25(landmarks, "Neck");
  if (!midHip || !neck) return null;

  const ySign: 1 | -1 = neck.y < midHip.y ? -1 : 1;
  const visibleFeet = collectVisibleWorldPoints(landmarks, FOOT_BODY25_NAMES);
  const visibleTop = collectVisibleWorldPoints(landmarks, TOP_BODY25_NAMES);
  const footRawY = visibleFeet.length > 0
    ? Math.min(...visibleFeet.map((point) => rawY(point, midHip, ySign)))
    : Math.min(0, rawY(midHip, midHip, ySign));
  const topRawY = visibleTop.length > 0
    ? Math.max(...visibleTop.map((point) => rawY(point, midHip, ySign)))
    : rawY(neck, midHip, ySign) + ESTIMATED_BONE_TORSO_HEIGHT_FALLBACK;

  const rawBodyHeight = topRawY - footRawY;
  const rawTorsoHeight = Math.abs(rawY(neck, midHip, ySign));
  const targetHeight = avatarMetrics?.height ?? DEFAULT_AVATAR_HEIGHT;
  const targetGroundY = avatarMetrics?.groundY ?? DEFAULT_AVATAR_GROUND_Y;
  const scale = rawBodyHeight > 1e-5
    ? targetHeight / rawBodyHeight
    : targetHeight / Math.max(rawTorsoHeight, ESTIMATED_BONE_TORSO_HEIGHT_FALLBACK);

  const yOffset = targetGroundY - footRawY * scale;

  return { landmarks, origin: midHip, ySign, scale, yOffset };
}

function worldPointToVrmVector(point: MediaPipeLandmark, context: WorldSkeletonContext) {
  const raw = toRawVrmVector(point, context.origin, context.ySign);
  return raw.multiplyScalar(context.scale).add(new THREE.Vector3(0, context.yOffset, 0));
}

function posePointToFallbackVrmVector(point: PosePoint) {
  return new THREE.Vector3(
    (point.x - 0.5) * 4,
    -(point.y - 0.5) * 4,
    -point.z * 2
  );
}

function getEstimatedSkeletonVector(
  person: PosePerson,
  name: string,
  context: WorldSkeletonContext | null
) {
  if (context) {
    const worldPoint = getWorldLandmarkForBody25(context.landmarks, name);
    if (worldPoint) return worldPointToVrmVector(worldPoint, context);
  }

  const fallbackPoint = person.keypoints[name];
  return fallbackPoint ? posePointToFallbackVrmVector(fallbackPoint) : null;
}

function buildEstimatedSkeletonSegments(
  person: PosePerson | null,
  avatarMetrics: AvatarSceneMetrics | null
): Array<[THREE.Vector3, THREE.Vector3]> {
  if (!person) return [];

  const context = buildWorldSkeletonContext(person, avatarMetrics);
  const segments: Array<[THREE.Vector3, THREE.Vector3]> = [];

  for (const [fromName, toName] of BODY25_BONES) {
    const from = getEstimatedSkeletonVector(person, fromName, context);
    const to = getEstimatedSkeletonVector(person, toName, context);
    if (from && to) segments.push([from, to]);
  }

  return segments;
}

function drawCameraFrameOnCanvas(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  mirrorX: boolean
) {
  ctx.save();

  if (mirrorX) {
    ctx.translate(VIDEO_WIDTH, 0);
    ctx.scale(-1, 1);
  }

  ctx.drawImage(image, 0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
  ctx.restore();
}

function drawBody25OnCanvas(
  ctx: CanvasRenderingContext2D,
  person: PosePerson,
  mirrorX = false
) {
  ctx.save();
  ctx.strokeStyle = "#00ff00";
  ctx.fillStyle = "#00ff00";
  ctx.lineWidth = 2;

  const pointToCanvas = (name: string) => {
    const point = person.keypoints[name];
    if (!point || point.score < 0.2) return null;
    return {
      x: (mirrorX ? 1 - point.x : point.x) * VIDEO_WIDTH,
      y: point.y * VIDEO_HEIGHT,
    };
  };

  for (const [fromName, toName] of BODY25_BONES) {
    const from = pointToCanvas(fromName);
    const to = pointToCanvas(toName);
    if (!from || !to) continue;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  for (const name of Object.keys(person.keypoints)) {
    const point = pointToCanvas(name);
    if (!point) continue;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function loadVrm(
  scene: THREE.Scene,
  vrmRef: React.MutableRefObject<VRM | null>,
  mirrorGroupRef: React.MutableRefObject<THREE.Group | null>,
  skeletonHelperRef: React.MutableRefObject<THREE.SkeletonHelper | null>,
  avatarMetricsRef: React.MutableRefObject<AvatarSceneMetrics | null>,
  debugDisplayRef: React.MutableRefObject<DebugDisplaySettings>,
  setStatus: React.Dispatch<React.SetStateAction<UiStatus>>
): Promise<void> {
  setStatus((s) => ({ ...s, vrm: "loading" }));

  const loader = new GLTFLoader();
  loader.register((parser: any) => new VRMLoaderPlugin(parser));

  return new Promise<void>((resolve, reject) => {
    loader.load(
      "VRoid_Woman.vrm",
      (gltf: any) => {
        const vrm = gltf.userData.vrm as VRM;

        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.removeUnnecessaryJoints(gltf.scene);

        vrm.scene.position.set(0, -1.05, 0);
        vrm.scene.rotation.set(0, Math.PI, 0);
        vrm.scene.scale.setScalar(1.0);
        vrm.humanoid.resetNormalizedPose();
        vrm.humanoid.update();

        const mirrorGroup = new THREE.Group();
        mirrorGroup.scale.set(debugDisplayRef.current.mirrorAvatarPose ? -1 : 1, 1, 1);
        mirrorGroup.add(vrm.scene);
        scene.add(mirrorGroup);

        const skeletonHelper = new THREE.SkeletonHelper(vrm.scene);
        skeletonHelper.visible = debugDisplayRef.current.showVrmSkeleton;
        skeletonHelper.frustumCulled = false;
        scene.add(skeletonHelper);

        const metrics = measureAvatarScene(vrm.scene);
        avatarMetricsRef.current = metrics;

        vrmRef.current = vrm;
        mirrorGroupRef.current = mirrorGroup;
        skeletonHelperRef.current = skeletonHelper;

        setStatus((s) => ({ ...s, vrm: "ready" }));
        resolve();
      },
      undefined,
      (error: unknown) => {
        console.error("VRM load error", error);
        setStatus((s) => ({
          ...s,
          vrm: "error",
          error: `Failed to load VRM: ${String(error)}`,
        }));
        reject(error);
      }
    );
  });
}

const HomeScreen: React.FC = () => {
  const [status, setStatus] = useState<UiStatus>({
    camera: "idle",
    pose: "idle",
    tracking: "idle",
    vrm: "idle",
    error: undefined,
  });
  const [showWebcamBones, setShowWebcamBones] = useState(true);
  const [showEstimatedBones, setShowEstimatedBones] = useState(true);
  const [showVrmSkeleton, setShowVrmSkeleton] = useState(true);
  const [mirrorAvatarPose, setMirrorAvatarPose] = useState(DEFAULT_MIRROR_AVATAR_POSE);

  const threeRef = useRef<ThreeContext | null>(null);
  const vrmRef = useRef<VRM | null>(null);
  const avatarMirrorGroupRef = useRef<THREE.Group | null>(null);
  const skeletonHelperRef = useRef<THREE.SkeletonHelper | null>(null);
  const estimatedSkeletonGroupRef = useRef<THREE.Group | null>(null);
  const estimatedSkeletonLineRef = useRef<THREE.LineSegments | null>(null);
  const avatarMetricsRef = useRef<AvatarSceneMetrics | null>(null);
  const lastPersonRef = useRef<PosePerson | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const debugDisplayRef = useRef<DebugDisplaySettings>({
    showWebcamBones: true,
    showEstimatedBones: true,
    showVrmSkeleton: true,
    mirrorAvatarPose: DEFAULT_MIRROR_AVATAR_POSE,
  });

  useEffect(() => {
    debugDisplayRef.current = {
      showWebcamBones,
      showEstimatedBones,
      showVrmSkeleton,
      mirrorAvatarPose,
    };

    if (skeletonHelperRef.current) {
      skeletonHelperRef.current.visible = showVrmSkeleton;
    }
    if (estimatedSkeletonGroupRef.current) {
      estimatedSkeletonGroupRef.current.visible = showEstimatedBones;
      estimatedSkeletonGroupRef.current.scale.set(mirrorAvatarPose ? -1 : 1, 1, 1);
    }
    if (avatarMirrorGroupRef.current) {
      avatarMirrorGroupRef.current.scale.set(mirrorAvatarPose ? -1 : 1, 1, 1);
    }
  }, [showWebcamBones, showEstimatedBones, showVrmSkeleton, mirrorAvatarPose]);

  useEffect(() => {
    if (Platform.OS !== "web") return;

    let cancelled = false;
    let pose: any = null;
    let camera: any = null;

    const video = document.getElementById("input-video") as HTMLVideoElement | null;
    const overlay = document.getElementById("landmark-overlay") as HTMLCanvasElement | null;
    const vrmCanvas = document.getElementById("vrm-canvas") as HTMLCanvasElement | null;

    if (!video || !overlay || !vrmCanvas) {
      console.error("Required DOM elements are missing");
      return;
    }

    overlay.width = VIDEO_WIDTH;
    overlay.height = VIDEO_HEIGHT;
    const ctx2d = overlay.getContext("2d");
    if (!ctx2d) {
      console.error("Failed to get 2D context for camera overlay");
      return;
    }

    const three = setupThree(vrmCanvas);
    threeRef.current = three;

    const estimatedSkeletonGroup = new THREE.Group();
    estimatedSkeletonGroup.scale.set(debugDisplayRef.current.mirrorAvatarPose ? -1 : 1, 1, 1);
    const estimatedSkeletonLine = createLineSegments(0xff00ff);
    estimatedSkeletonGroup.visible = debugDisplayRef.current.showEstimatedBones;
    estimatedSkeletonGroup.add(estimatedSkeletonLine);
    three.scene.add(estimatedSkeletonGroup);
    estimatedSkeletonGroupRef.current = estimatedSkeletonGroup;
    estimatedSkeletonLineRef.current = estimatedSkeletonLine;

    loadVrm(
      three.scene,
      vrmRef,
      avatarMirrorGroupRef,
      skeletonHelperRef,
      avatarMetricsRef,
      debugDisplayRef,
      setStatus
    ).catch((err) => {
      console.error("VRM load error", err);
    });

    async function initCameraAndPose() {
      try {
        setStatus((s) => ({ ...s, camera: "initializing", pose: "idle" }));

        await loadCameraUtilsFromCdn();
        const PoseCtor = await loadPoseFromCdn();

        if (cancelled) return;

        pose = new PoseCtor({
          locateFile: (file: string) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5/${file}`,
        });

        // Match pose_estimation/backend/app.py: MediaPipe Pose, model_complexity=2.
        pose.setOptions({
          staticImageMode: false,
          modelComplexity: 2,
          smoothLandmarks: true,
          enableSegmentation: false,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });

        pose.onResults((results: any) => {
          if (cancelled) return;

          const mirrorWebcamDisplay =
            debugDisplayRef.current.mirrorAvatarPose !== DEFAULT_MIRROR_AVATAR_POSE;

          ctx2d.clearRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
          drawCameraFrameOnCanvas(ctx2d, results.image, mirrorWebcamDisplay);

          const person = webcamResultsToPosePerson(results);
          lastPersonRef.current = person;

          if (person && debugDisplayRef.current.showWebcamBones) {
            drawBody25OnCanvas(ctx2d, person, mirrorWebcamDisplay);
          }

          const vrm = vrmRef.current;
          const applied = vrm ? applyPoseEstimationKalidokitToVrm(vrm, person) : false;

          if (person && estimatedSkeletonLineRef.current) {
            updateLineSegments(
              estimatedSkeletonLineRef.current,
              buildEstimatedSkeletonSegments(person, avatarMetricsRef.current)
            );
          }

          setStatus((s) => ({
            ...s,
            tracking: applied
              ? "running: pose_estimation Kalidokit path"
              : person
                ? "waiting for mediapipeWorldLandmarks"
                : "waiting for pose",
          }));
        });

        const CameraCtor = (window as any).Camera;
        if (!CameraCtor) {
          throw new Error("MediaPipe Camera helper was not loaded");
        }

        camera = new CameraCtor(video, {
          onFrame: async () => {
            if (!cancelled && pose) {
              await pose.send({ image: video });
            }
          },
          width: VIDEO_WIDTH,
          height: VIDEO_HEIGHT,
        });

        setStatus((s) => ({
          ...s,
          camera: "running",
          pose: "running",
          tracking: "waiting for pose",
        }));
        await camera.start();

        const mediaStream = video.srcObject as MediaStream | null;
        if (mediaStream) streamRef.current = mediaStream;
      } catch (err: any) {
        console.error("Failed to initialize camera / pose", err);
        setStatus((s) => ({
          ...s,
          camera: "error",
          pose: "error",
          tracking: "error",
          error: String(err?.message || err),
        }));
      }
    }

    initCameraAndPose();

    const renderLoop = () => {
      if (cancelled || !threeRef.current) return;

      const { renderer, scene, camera: threeCamera, clock } = threeRef.current;
      const deltaTime = clock.getDelta();

      if (vrmRef.current) {
        vrmRef.current.update(deltaTime);
      }
      skeletonHelperRef.current?.updateMatrixWorld(true);

      renderer.render(scene, threeCamera);
      requestAnimationFrame(renderLoop);
    };

    requestAnimationFrame(renderLoop);

    return () => {
      cancelled = true;

      if (camera && typeof camera.stop === "function") {
        try { camera.stop(); } catch { /* ignore */ }
      }
      if (pose && typeof pose.close === "function") {
        try { pose.close(); } catch { /* ignore */ }
      }

      const stream = streamRef.current;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

      if (skeletonHelperRef.current) {
        disposeSkeletonHelper(skeletonHelperRef.current);
        skeletonHelperRef.current = null;
      }
      if (estimatedSkeletonLineRef.current) {
        estimatedSkeletonLineRef.current.geometry.dispose();
        (estimatedSkeletonLineRef.current.material as THREE.Material).dispose();
        estimatedSkeletonLineRef.current = null;
      }
      if (vrmRef.current) {
        disposeObject(vrmRef.current.scene);
        vrmRef.current = null;
      }
      if (threeRef.current) {
        threeRef.current.renderer.dispose();
        threeRef.current = null;
      }
    };
  }, []);

  if (Platform.OS !== "web") {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Web camera to VRM demo is only supported on the web.</Text>
      </View>
    );
  }

  const REPO_URL = "https://github.com/europanite/webcam_to_avatar";

  const renderToggle = (label: string, enabled: boolean, onPress: () => void) => (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ selected: enabled }}
      onPress={onPress}
      style={[styles.controlButton, enabled && styles.controlButtonActive]}
    >
      <Text style={[styles.controlButtonText, enabled && styles.controlButtonTextActive]}>
        {enabled ? "ON" : "OFF"} · {label}
      </Text>
    </TouchableOpacity>
  );

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <TouchableOpacity onPress={() => Linking.openURL(REPO_URL)}>
        <Text style={styles.title}>WebCam to VRM</Text>
      </TouchableOpacity>
      <Text style={styles.description}>
        This version follows pose_estimation's active VRM path: MediaPipe Pose
        landmarks are passed to Kalidokit.Pose.solve, then normalized VRM bones are
        updated with resetNormalizedPose and direct local Euler rotations.
      </Text>

      <View style={styles.statusBox}>
        <Text style={styles.statusText}>Camera: {status.camera}</Text>
        <Text style={styles.statusText}>Pose: {status.pose}</Text>
        <Text style={styles.statusText}>Tracking: {status.tracking}</Text>
        <Text style={styles.statusText}>VRM: {status.vrm}</Text>
        {status.error ? <Text style={styles.errorText}>{status.error}</Text> : null}
      </View>

      <View style={styles.controlsBox}>
        <Text style={styles.controlsTitle}>Debug display controls</Text>
        <View style={styles.controlsRow}>
          {renderToggle("Web camera bones", showWebcamBones, () => setShowWebcamBones((value) => !value))}
          {renderToggle("Estimated avatar bones", showEstimatedBones, () => setShowEstimatedBones((value) => !value))}
          {renderToggle("VRM skeleton", showVrmSkeleton, () => setShowVrmSkeleton((value) => !value))}
          {renderToggle("Mirror avatar X", mirrorAvatarPose, () => setMirrorAvatarPose((value) => !value))}
        </View>
      </View>

      <View style={styles.canvasGrid}>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Web camera / BODY_25 check</Text>
          <View style={styles.videoWrap}>
            <video
              id="input-video"
              width={VIDEO_WIDTH}
              height={VIDEO_HEIGHT}
              style={styles.hiddenVideo as any}
              playsInline
              muted
            />
            <canvas
              id="landmark-overlay"
              width={VIDEO_WIDTH}
              height={VIDEO_HEIGHT}
              style={styles.canvas as any}
            />
          </View>
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>VRM / pose_estimation avatar path</Text>
          <canvas
            id="vrm-canvas"
            width={VIDEO_WIDTH}
            height={VIDEO_HEIGHT}
            style={styles.canvas as any}
          />
          <Text style={styles.legend}>cyan: VRM skeleton / magenta: estimated avatar bones / green: webcam bones</Text>
        </View>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    backgroundColor: "#111827",
    flexGrow: 1,
    padding: 24,
  },
  title: {
    color: "#f9fafb",
    fontSize: 28,
    fontWeight: "700",
    marginBottom: 8,
  },
  description: {
    color: "#d1d5db",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
    maxWidth: 980,
    textAlign: "center",
  },
  statusBox: {
    backgroundColor: "#1f2937",
    borderRadius: 12,
    marginBottom: 16,
    padding: 12,
    width: "100%",
    maxWidth: 980,
  },
  statusText: {
    color: "#e5e7eb",
    fontSize: 14,
  },
  errorText: {
    color: "#fca5a5",
    marginTop: 8,
  },
  controlsBox: {
    backgroundColor: "#1f2937",
    borderRadius: 12,
    marginBottom: 16,
    maxWidth: 980,
    padding: 12,
    width: "100%",
  },
  controlsTitle: {
    color: "#f9fafb",
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 10,
  },
  controlsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  controlButton: {
    backgroundColor: "#111827",
    borderColor: "#475569",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  controlButtonActive: {
    backgroundColor: "#dbeafe",
    borderColor: "#93c5fd",
  },
  controlButtonText: {
    color: "#cbd5e1",
    fontSize: 13,
    fontWeight: "700",
  },
  controlButtonTextActive: {
    color: "#0f172a",
  },
  canvasGrid: {
    alignItems: "flex-start",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 16,
    justifyContent: "center",
  },
  panel: {
    backgroundColor: "#0f172a",
    borderRadius: 16,
    padding: 12,
  },
  panelTitle: {
    color: "#f9fafb",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 8,
    textAlign: "center",
  },
  videoWrap: {
    height: VIDEO_HEIGHT,
    position: "relative",
    width: VIDEO_WIDTH,
  },
  hiddenVideo: {
    display: "none",
  },
  canvas: {
    backgroundColor: "#000",
    borderRadius: 12,
    height: VIDEO_HEIGHT,
    width: VIDEO_WIDTH,
  },
  legend: {
    color: "#cbd5e1",
    fontSize: 12,
    marginTop: 8,
    textAlign: "center",
  },
});

export default HomeScreen;
