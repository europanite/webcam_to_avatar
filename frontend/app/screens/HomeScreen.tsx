import React, { useEffect, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-backend-webgl";
import * as posedetection from "@tensorflow-models/pose-detection";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import { VRM, VRMUtils, VRMLoaderPlugin } from "@pixiv/three-vrm";

/**
 * Allow using <video> and <canvas> tags in TSX for React Native Web.
 */
declare global {
  namespace JSX {
    interface IntrinsicElements {
      video: any;
      canvas: any;
    }
  }
}

type Detector = posedetection.PoseDetector;
type Keypoint = posedetection.Keypoint;

const VIDEO_WIDTH = 640;
const VIDEO_HEIGHT = 480;
const VRM_WIDTH = 480;
const VRM_HEIGHT = 640;
const MIN_KEYPOINT_SCORE = 0.3;

const SKELETON_EDGES: Array<[posedetection.KeypointName, posedetection.KeypointName]> = [
  // Torso
  ["left_shoulder", "right_shoulder"],
  ["left_hip", "right_hip"],
  ["left_shoulder", "left_hip"],
  ["right_shoulder", "right_hip"],

  // Left arm
  ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"],

  // Right arm
  ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"],

  // Left leg
  ["left_hip", "left_knee"],
  ["left_knee", "left_ankle"],

  // Right leg
  ["right_hip", "right_knee"],
  ["right_knee", "right_ankle"],
];

function getKeypoint(
  keypoints: Keypoint[],
  name: posedetection.KeypointName,
  minScore: number = MIN_KEYPOINT_SCORE,
): Keypoint | null {
  const kp = keypoints.find((k) => k.name === name);
  if (!kp || (kp.score ?? 0) < minScore) return null;
  return kp;
}

function drawSkeletonOnCanvas(ctx: CanvasRenderingContext2D, keypoints: Keypoint[]): void {
  ctx.save();
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  ctx.lineWidth = 4;
  ctx.strokeStyle = "#00bcd4";
  ctx.fillStyle = "#ff4081";

  // Draw bones
  for (const [aName, bName] of SKELETON_EDGES) {
    const a = getKeypoint(keypoints, aName);
    const b = getKeypoint(keypoints, bName);
    if (!a || !b) continue;

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // Draw joints
  for (const kp of keypoints) {
    if ((kp.score ?? 0) < MIN_KEYPOINT_SCORE) continue;
    ctx.beginPath();
    ctx.arc(kp.x, kp.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * VRM bone names we want to control.
 * These strings are accepted by vrm.humanoid.getNormalizedBoneNode("hips" | "spine" | ...).
 */
const VRM_BONE_NAMES = {
  hips: "hips",
  spine: "spine",
  chest: "chest",
  upperChest: "upperChest",
  neck: "neck",
  head: "head",
  leftUpperArm: "leftUpperArm",
  leftLowerArm: "leftLowerArm",
  rightUpperArm: "rightUpperArm",
  rightLowerArm: "rightLowerArm",
  leftUpperLeg: "leftUpperLeg",
  leftLowerLeg: "leftLowerLeg",
  rightUpperLeg: "rightUpperLeg",
  rightLowerLeg: "rightLowerLeg",
} as const;

type BoneName = keyof typeof VRM_BONE_NAMES;
type BoneInitialRotations = Map<BoneName, THREE.Quaternion>;

interface ThreeContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  clock: THREE.Clock;
}

/**
 * Get the humanoid bone node (normalized) from a VRM instance.
 */
function getHumanoidBoneNode(vrm: VRM | null, bone: BoneName): THREE.Object3D | null {
  if (!vrm || !vrm.humanoid) return null;
  // The string keys like "hips", "leftUpperArm" are accepted by getNormalizedBoneNode
  const node = vrm.humanoid.getNormalizedBoneNode(VRM_BONE_NAMES[bone] as any);
  return node ?? null;
}

/**
 * Cache the initial local rotation (quaternion) of each bone.
 */
function cacheInitialBoneRotations(vrm: VRM | null, map: BoneInitialRotations): void {
  if (!vrm || !vrm.humanoid) return;
  (Object.keys(VRM_BONE_NAMES) as BoneName[]).forEach((bone) => {
    const node = getHumanoidBoneNode(vrm, bone);
    if (node) {
      map.set(bone, node.quaternion.clone());
    }
  });
}

/**
 * Reset all controlled bones to their cached initial rotation.
 */
function resetBonesToInitial(vrm: VRM | null, map: BoneInitialRotations): void {
  if (!vrm || !vrm.humanoid) return;
  (Object.keys(VRM_BONE_NAMES) as BoneName[]).forEach((bone) => {
    const node = getHumanoidBoneNode(vrm, bone);
    const initial = map.get(bone);
    if (node && initial) {
      node.quaternion.copy(initial);
    }
  });
}

/**
 * Apply a delta Euler rotation (in local space) on top of the cached initial rotation.
 */
function setLocalEulerDelta(
  vrm: VRM | null,
  map: BoneInitialRotations,
  bone: BoneName,
  deltaEuler: THREE.Euler,
): void {
  const node = getHumanoidBoneNode(vrm, bone);
  const initial = map.get(bone);
  if (!node || !initial) return;

  const deltaQ = new THREE.Quaternion().setFromEuler(deltaEuler);
  node.quaternion.copy(initial).multiply(deltaQ);
}

/**
 * Create a normalized 2D vector from keypoint A to keypoint B.
 * Camera coordinates: origin at top-left, x to the right, y down.
 */
function vec2FromKeypoints(a: Keypoint, b: Keypoint): THREE.Vector2 {
  const v = new THREE.Vector2(b.x - a.x, b.y - a.y);
  if (v.lengthSq() === 0) return new THREE.Vector2(0, 0);
  return v.normalize();
}

/**
 * Signed angle between two 2D vectors in the image plane.
 * Returns angle in radians in the range [-π, π].
 */
function signedAngleBetweenVecs2D(a: THREE.Vector2, b: THREE.Vector2): number {
  if (a.lengthSq() === 0 || b.lengthSq() === 0) return 0;
  const aN = a.clone().normalize();
  const bN = b.clone().normalize();
  const dot = THREE.MathUtils.clamp(aN.dot(bN), -1, 1);
  const cross = aN.x * bN.y - aN.y * bN.x;
  return Math.atan2(cross, dot);
}

/**
 * Basic, robust pose retargeting:
 * - Torso tilt from hip -> shoulder
 * - Head orientation from shoulders & nose
 * - Arm abduction from shoulder -> elbow in 2D (this part fixes baseLeftAngle/leftAbduction issue)
 * - Leg flexion from hip -> knee
 */
function applyPoseToVRMFromKeypoints(
  vrm: VRM | null,
  keypoints: Keypoint[],
  initialMap: BoneInitialRotations,
): void {
  if (!vrm) return;
  if (initialMap.size === 0) {
    cacheInitialBoneRotations(vrm, initialMap);
    if (initialMap.size === 0) return;
  }

  const nose = getKeypoint(keypoints, "nose");
  const leftShoulder = getKeypoint(keypoints, "left_shoulder");
  const rightShoulder = getKeypoint(keypoints, "right_shoulder");
  const leftHip = getKeypoint(keypoints, "left_hip");
  const rightHip = getKeypoint(keypoints, "right_hip");
  const leftElbow = getKeypoint(keypoints, "left_elbow");
  const rightElbow = getKeypoint(keypoints, "right_elbow");
  const leftKnee = getKeypoint(keypoints, "left_knee");
  const rightKnee = getKeypoint(keypoints, "right_knee");

  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) {
    // Not enough data for a stable torso; just reset
    resetBonesToInitial(vrm, initialMap);
    return;
  }

  // --- Torso: hips, spine, chest tilt (front/back) -----------------------------------
  const midHip = {
    x: (leftHip.x + rightHip.x) / 2,
    y: (leftHip.y + rightHip.y) / 2,
    score: Math.min(leftHip.score ?? 0, rightHip.score ?? 0),
    name: "mid_hip",
  } as Keypoint;

  const midShoulder = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
    score: Math.min(leftShoulder.score ?? 0, rightShoulder.score ?? 0),
    name: "mid_shoulder",
  } as Keypoint;

  const torsoVec = vec2FromKeypoints(midHip, midShoulder);
  // Image y-axis is down, so "lean forward" is torsoVec.y < 0 (toward top)
  const torsoPitch = THREE.MathUtils.clamp(-torsoVec.y * 0.5, -0.6, 0.6);

  setLocalEulerDelta(vrm, initialMap, "hips", new THREE.Euler(torsoPitch * 0.3, 0, 0));
  setLocalEulerDelta(vrm, initialMap, "spine", new THREE.Euler(torsoPitch * 0.4, 0, 0));
  setLocalEulerDelta(vrm, initialMap, "chest", new THREE.Euler(torsoPitch * 0.3, 0, 0));

  // --- Head: simple look direction from shoulders & nose -----------------------------
  if (nose) {
    const shouldersVec = vec2FromKeypoints(leftShoulder, rightShoulder);
    // yaw: rotation around Y axis (left / right turning)
    const headYaw = THREE.MathUtils.clamp(
      signedAngleBetweenVecs2D(new THREE.Vector2(1, 0), shouldersVec) * 0.5,
      -0.6,
      0.6,
    );

    // pitch: nose relative to mid shoulders (up / down)
    const headPitch = THREE.MathUtils.clamp(
      ((midShoulder.y - nose.y) / VIDEO_HEIGHT) * 2.0,
      -0.5,
      0.5,
    );

    setLocalEulerDelta(
      vrm,
      initialMap,
      "neck",
      new THREE.Euler(headPitch * 0.3, headYaw * 0.3, 0),
    );
    setLocalEulerDelta(
      vrm,
      initialMap,
      "head",
      new THREE.Euler(headPitch * 0.7, headYaw * 0.7, 0),
    );
  }

  // --- Arms: abduction from shoulder->elbow (FIX for baseLeftAngle/leftAbduction) ----
  if (leftElbow) {
    const leftUpperArmVec = vec2FromKeypoints(leftShoulder, leftElbow);
    const leftHorizontal = new THREE.Vector2(-1, 0); // T-pose reference (pointing to the left)
    // Negative when arm goes up, positive when it goes down
    const leftAngleFromHorizontal = signedAngleBetweenVecs2D(leftHorizontal, leftUpperArmVec);
    // We want positive for raising, negative for lowering
    const leftAbduction = THREE.MathUtils.clamp(-leftAngleFromHorizontal, -Math.PI / 2, Math.PI / 2);

    setLocalEulerDelta(
      vrm,
      initialMap,
      "leftUpperArm",
      // Rotate around Z to move arm up/down in screen space
      new THREE.Euler(0, 0, leftAbduction),
    );
  }

  if (rightElbow) {
    const rightUpperArmVec = vec2FromKeypoints(rightShoulder, rightElbow);
    const rightHorizontal = new THREE.Vector2(1, 0); // T-pose reference (pointing to the right)
    // Positive when arm goes up, negative when it goes down
    const rightAngleFromHorizontal = signedAngleBetweenVecs2D(
      rightHorizontal,
      rightUpperArmVec,
    );
    const rightAbduction = THREE.MathUtils.clamp(
      rightAngleFromHorizontal,
      -Math.PI / 2,
      Math.PI / 2,
    );

    setLocalEulerDelta(
      vrm,
      initialMap,
      "rightUpperArm",
      new THREE.Euler(0, 0, rightAbduction),
    );
  }

  // Debug: these values should now change smoothly and NOT stay at ±π/2
  // and leftAngle should not be stuck negative because we use signed angle directly.
  // Comment out if too noisy.
  console.debug("Arm abduction", {
    left: {
      hasElbow: !!leftElbow,
    },
    right: {
      hasElbow: !!rightElbow,
    },
  });

  // --- Legs: simple flexion from hip->knee -------------------------------------------
  if (leftKnee) {
    const leftLegVec = vec2FromKeypoints(leftHip, leftKnee);
    const legDown = new THREE.Vector2(0, 1);
    const leftLegAngle = signedAngleBetweenVecs2D(legDown, leftLegVec);
    const leftFlex = THREE.MathUtils.clamp(leftLegAngle, -0.7, 0.7);
    setLocalEulerDelta(
      vrm,
      initialMap,
      "leftUpperLeg",
      new THREE.Euler(leftFlex, 0, 0),
    );
  }

  if (rightKnee) {
    const rightLegVec = vec2FromKeypoints(rightHip, rightKnee);
    const legDown = new THREE.Vector2(0, 1);
    const rightLegAngle = signedAngleBetweenVecs2D(legDown, rightLegVec);
    const rightFlex = THREE.MathUtils.clamp(rightLegAngle, -0.7, 0.7);
    setLocalEulerDelta(
      vrm,
      initialMap,
      "rightUpperLeg",
      new THREE.Euler(rightFlex, 0, 0),
    );
  }
}

/**
 * Main WebCamera / VRM canvas layout.
 * (Only rendered on web)
 */
const WebCameraAndVrmView: React.FC = () => {
  if (Platform.OS !== "web") return null;

  return (
    <View style={styles.cameraRow}>
      <View style={styles.cameraBox}>
        <video
          id="camera-video"
          style={styles.video}
          autoPlay
          muted
          playsInline
        />
        <canvas id="camera-overlay" style={styles.cameraOverlay} />
      </View>
      <View style={styles.vrmBox}>
        <canvas id="vrm-canvas" style={styles.vrmCanvas} />
      </View>
    </View>
  );
};

interface UiStatus {
  tf: string;
  camera: string;
  detector: string;
  tracking: string;
  vrm: string;
  error?: string;
}

const initialStatus: UiStatus = {
  tf: "idle",
  camera: "idle",
  detector: "idle",
  tracking: "idle",
  vrm: "idle",
  error: undefined,
};

export default function HomeScreen() {
  const [status, setStatus] = useState<UiStatus>(initialStatus);

  const detectorRef = useRef<Detector | null>(null);
  const vrmRef = useRef<VRM | null>(null);
  const bonesRef = useRef<BoneInitialRotations>(new Map());
  const threeRef = useRef<ThreeContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (Platform.OS !== "web") return;

    let cancelled = false;

    async function init() {
      try {
        setStatus((s) => ({ ...s, tf: "initializing" }));

        await tf.ready();
        await tf.setBackend("webgl");
        setStatus((s) => ({ ...s, tf: "ready" }));

        // --- Camera -------------------------------------------------------
        setStatus((s) => ({ ...s, camera: "initializing" }));
        const video = document.getElementById("camera-video") as HTMLVideoElement | null;
        const overlay = document.getElementById("camera-overlay") as HTMLCanvasElement | null;

        if (!video || !overlay) {
          throw new Error("Camera DOM elements not found");
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            width: VIDEO_WIDTH,
            height: VIDEO_HEIGHT,
          },
        });
        streamRef.current = stream;
        video.srcObject = stream;

        await new Promise<void>((resolve) => {
          video.onloadedmetadata = () => {
            video.play().then(() => resolve()).catch(() => resolve());
          };
        });

        overlay.width = VIDEO_WIDTH;
        overlay.height = VIDEO_HEIGHT;

        setStatus((s) => ({ ...s, camera: "ready" }));

        // --- Detector ------------------------------------------------------
        setStatus((s) => ({ ...s, detector: "initializing" }));

        const detector = await posedetection.createDetector(
          posedetection.SupportedModels.MoveNet,
          {
            modelType: posedetection.movenet.modelType.SINGLEPOSE_THUNDER,
            enableSmoothing: true,
          } as posedetection.MoveNetModelConfig,
        );
        detectorRef.current = detector;
        setStatus((s) => ({ ...s, detector: "ready" }));

        // --- Three.js & VRM -----------------------------------------------
        setStatus((s) => ({ ...s, vrm: "initializing" }));

        const vrmCanvas = document.getElementById("vrm-canvas") as HTMLCanvasElement | null;
        if (!vrmCanvas) {
          throw new Error("VRM canvas not found");
        }

        const renderer = new THREE.WebGLRenderer({
          canvas: vrmCanvas,
          alpha: true,
          antialias: true,
        });
        renderer.setSize(VRM_WIDTH, VRM_HEIGHT);
        renderer.setPixelRatio(window.devicePixelRatio || 1);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xffffff);

        const camera = new THREE.PerspectiveCamera(
          30,
          VRM_WIDTH / VRM_HEIGHT,
          0.1,
          20,
        );
        camera.position.set(0, 0.3, 3.5);

        const light = new THREE.DirectionalLight(0xffffff, 1);
        light.position.set(0, 3, 5);
        scene.add(light);
        scene.add(new THREE.AmbientLight(0xffffff, 0.5));

        const clock = new THREE.Clock();
        threeRef.current = { renderer, scene, camera, clock };

        // Load VRM
        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));

        loader.load(
          "avatar.vrm",
          (gltf) => {
            if (cancelled) return;
            const vrm = gltf.userData.vrm as VRM;

            VRMUtils.removeUnnecessaryJoints(vrm.scene);
            VRMUtils.rotateVRM0(vrm);

            // Face the camera
            vrm.scene.rotation.y = Math.PI;
            vrm.scene.rotation.y = 0;
            vrm.scene.position.set(0, -0.8, 0);

            scene.add(vrm.scene);
            vrmRef.current = vrm;

            cacheInitialBoneRotations(vrmRef.current, bonesRef.current);

            setStatus((s) => ({ ...s, vrm: "ready" }));
          },
          undefined,
          (error) => {
            console.error("VRM load error", error);
            setStatus((s) => ({ ...s, vrm: "error", error: String(error) }));
          },
        );

        const ctx2d = overlay.getContext("2d");
        if (!ctx2d) {
          throw new Error("Failed to get 2D context");
        }

        // --- Main render / tracking loop ----------------------------------
        async function loop() {
          if (cancelled) return;

          const det = detectorRef.current;
          const vrm = vrmRef.current;
          const three = threeRef.current;

          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && det) {
            try {
              const poses = await det.estimatePoses(video, {
                maxPoses: 1,
                flipHorizontal: false, // Mirror like a webcam
              });

              if (poses && poses.length > 0) {
                const pose = poses[0];
                if (pose.keypoints) {
                  drawSkeletonOnCanvas(ctx2d, pose.keypoints);
                  setStatus((s) => ({ ...s, tracking: "tracking" }));

                  if (vrm) {
                    try {
                      applyPoseToVRMFromKeypoints(
                        vrm,
                        pose.keypoints,
                        bonesRef.current,
                      );
                    } catch (e) {
                      console.error("Pose estimation / retargeting failed", e);
                      setStatus((s) => ({
                        ...s,
                        error: `Pose estimation / retargeting failed: ${String(e)}`,
                      }));
                    }
                  }
                }
              } else {
                setStatus((s) => ({ ...s, tracking: "no person" }));
                ctx2d.clearRect(0, 0, overlay.width, overlay.height);
                if (vrm) {
                  resetBonesToInitial(vrm, bonesRef.current);
                }
              }
            } catch (e) {
              console.error("Pose estimation failed", e);
              setStatus((s) => ({
                ...s,
                tracking: "error",
                error: `Pose estimation failed: ${String(e)}`,
              }));
            }
          }

          if (three && vrmRef.current) {
            const delta = three.clock.getDelta();
            vrmRef.current.update(delta);
            three.renderer.render(three.scene, three.camera);
          }

          requestAnimationFrame(loop);
        }

        requestAnimationFrame(loop);
      } catch (e) {
        console.error("Initialization error", e);
        setStatus((s) => ({
          ...s,
          tf: s.tf === "idle" ? "error" : s.tf,
          camera: s.camera === "idle" ? "error" : s.camera,
          detector: s.detector === "idle" ? "error" : s.detector,
          vrm: s.vrm === "idle" ? "error" : s.vrm,
          error: `Initialization error: ${String(e)}`,
        }));
      }
    }

    init();

    return () => {
      cancelled = true;
      const stream = streamRef.current;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
      const three = threeRef.current;
      if (three) {
        three.renderer.dispose();
      }
    };
  }, []);

  // Native platforms: show a simple message
  if (Platform.OS !== "web") {
    return (
      <View style={styles.nativeContainer}>
        <Text style={styles.title}>VRM Pose Tracking (Web only)</Text>
        <Text style={styles.statusText}>
          This demo is intended to run in a web browser (Expo Web).
        </Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Web Camera → VRM Pose Retargeting</Text>

      <WebCameraAndVrmView />

      <View style={styles.statusRow}>
        <View style={styles.statusBox}>
          <Text style={styles.statusLabel}>TFJS</Text>
          <Text style={styles.statusText}>{status.tf}</Text>
        </View>
        <View style={styles.statusBox}>
          <Text style={styles.statusLabel}>Camera</Text>
          <Text style={styles.statusText}>{status.camera}</Text>
        </View>
        <View style={styles.statusBox}>
          <Text style={styles.statusLabel}>Detector</Text>
          <Text style={styles.statusText}>{status.detector}</Text>
        </View>
        <View style={styles.statusBox}>
          <Text style={styles.statusLabel}>Tracking</Text>
          <Text style={styles.statusText}>{status.tracking}</Text>
        </View>
        <View style={styles.statusBox}>
          <Text style={styles.statusLabel}>VRM</Text>
          <Text style={styles.statusText}>{status.vrm}</Text>
        </View>
      </View>

      {status.error ? (
        <Text style={styles.errorText}>{status.error}</Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    paddingBottom: 32,
    backgroundColor: "#fafafa",
  },
  nativeContainer: {
    flex: 1,
    padding: 16,
    backgroundColor: "#fafafa",
    justifyContent: "center",
    alignItems: "center",
  },
  title: {
    fontSize: 20,
    fontWeight: "600",
    marginBottom: 12,
    textAlign: "center",
  },
  cameraRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "flex-start",
    gap: 16,
  } as any,
  cameraBox: {
    position: "relative",
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    backgroundColor: "#000",
    overflow: "hidden",
  },
  video: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
    transform: "scaleX(-1)", // mirror to behave like a webcam
  },
  cameraOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
  },
  vrmBox: {
    width: VRM_WIDTH,
    height: VRM_HEIGHT,
    backgroundColor: "#f0f0f0",
    borderRadius: 8,
    overflow: "hidden",
  },
  vrmCanvas: {
    width: "100%",
    height: "100%",
  },
  statusRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    marginTop: 16,
    gap: 8,
  } as any,
  statusBox: {
    minWidth: 90,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#ddd",
  },
  statusLabel: {
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 2,
  },
  statusText: {
    fontSize: 12,
  },
  errorText: {
    marginTop: 16,
    fontSize: 12,
    color: "#d32f2f",
  },
});
