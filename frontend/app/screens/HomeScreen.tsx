import React, { useEffect, useRef, useState } from "react";
import { 
  Platform, 
  ScrollView, 
  StyleSheet, 
  TouchableOpacity,
  Text, 
  View } from "react-native";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import { VRM, VRMUtils, VRMLoaderPlugin } from "@pixiv/three-vrm";
import * as Kalidokit from "kalidokit";

const VIDEO_WIDTH = 480;
const VIDEO_HEIGHT = 640;

interface ThreeContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  clock: THREE.Clock;
}

interface UiStatus {
  camera: string;
  holistic: string;
  tracking: string;
  vrm: string;
  error?: string;
}

/**
 * Dynamically load MediaPipe Holistic from CDN.
 * We avoid using `import` to prevent bundler issues like
 * "Holistic is not a constructor".
 */
async function loadHolisticFromCdn(): Promise<any> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("Holistic can only be loaded in a browser environment");
  }

  const existing = (window as any).Holistic;
  if (existing) {
    return existing;
  }

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5/holistic.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = (err) => reject(err);
    document.head.appendChild(script);
  });

  const HolisticCtor = (window as any).Holistic;
  if (!HolisticCtor) {
    throw new Error("Failed to load MediaPipe Holistic from CDN");
  }
  return HolisticCtor;
}

/**
 * Dynamically load MediaPipe Camera utilities (Camera helper).
 */
async function loadCameraUtilsFromCdn(): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  if ((window as any).Camera) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3/camera_utils.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = (err) => reject(err);
    document.head.appendChild(script);
  });
}

/**
 * Very small check for MediaPipe landmark arrays.
 * Ensures we have the expected number of landmarks and that
 * each landmark has finite x/y/z values.
 */
function isValidLandmarkArray(
  landmarks: any,
  expectedLength: number
): landmarks is Array<{ x: number; y: number; z: number }> {
  if (!landmarks || !Array.isArray(landmarks)) return false;
  if (landmarks.length < expectedLength) return false;

  for (let i = 0; i < expectedLength; i += 1) {
    const lm = landmarks[i];
    if (
      !lm ||
      typeof lm.x !== "number" ||
      typeof lm.y !== "number" ||
      typeof lm.z !== "number" ||
      Number.isNaN(lm.x) ||
      Number.isNaN(lm.y) ||
      Number.isNaN(lm.z)
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Helper: smoothly apply rotation to a VRM bone.
 */
function rigRotation(
  bone: THREE.Object3D,
  rotation: { x?: number; y?: number; z?: number } | null | undefined,
  dampener = 1,
  lerpAmount = 0.3
) {
  // Skip invalid rotation
  if (
    !rotation ||
    typeof rotation.x !== "number" ||
    typeof rotation.y !== "number" ||
    typeof rotation.z !== "number" ||
    Number.isNaN(rotation.x) ||
    Number.isNaN(rotation.y) ||
    Number.isNaN(rotation.z)
  ) {
    return;
  }

  // Convert Kalidokit euler (radians) to quaternion
  const euler = new THREE.Euler(
    rotation.x, 
    rotation.y, 
    rotation.z, 
    "XYZ"
  );
  const targetQuat = new THREE.Quaternion().setFromEuler(euler);

  // Just slerp the bone towards the target
  bone.quaternion.slerp(targetQuat, lerpAmount * dampener);
}

/**
 * Helper: smoothly apply hips position to a VRM bone.
 * Kalidokit uses normalized coordinates; we only apply small offsets.
 */
function rigPosition(
  bone: THREE.Object3D,
  position: { x: number; y: number; z: number },
  dampener = 1,
  lerpAmount = 0.1
) {
  const target = new THREE.Vector3(
    position.x,
    position.y,
    position.z
  ).multiplyScalar(dampener);
  bone.position.lerp(target, lerpAmount);
}

/**
 * Draw pose landmarks on the 2D overlay canvas so that the user
 * can see the tracking status.
 */
function drawPoseOnCanvas(
  ctx: CanvasRenderingContext2D,
  landmarks: Array<{ x: number; y: number; z: number }>
) {
  ctx.save();
  ctx.strokeStyle = "#00ff00";
  ctx.lineWidth = 2;

  const connect = (i: number, j: number) => {
    const a = landmarks[i];
    const b = landmarks[j];
    if (!a || !b) return;
    ctx.beginPath();
    ctx.moveTo(a.x * VIDEO_WIDTH, a.y * VIDEO_HEIGHT);
    ctx.lineTo(b.x * VIDEO_WIDTH, b.y * VIDEO_HEIGHT);
    ctx.stroke();
  };

  // Very small subset: arms + shoulders + hips.
  const pairs: Array<[number, number]> = [
    [11, 13],
    [13, 15],
    [12, 14],
    [14, 16],
    [11, 12],
    [11, 23],
    [12, 24],
    [23, 24],
  ];

  pairs.forEach(([i, j]) => connect(i, j));

  ctx.restore();
}

/**
 * Create basic three.js scene + camera + renderer targeting the given canvas.
 */
function setupThree(canvas: HTMLCanvasElement): ThreeContext {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setSize(VIDEO_WIDTH, VIDEO_HEIGHT);
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.outputEncoding = THREE.sRGBEncoding;

  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(
    60, // fov: The vertical field of view. Default is 50.
    VIDEO_WIDTH / VIDEO_HEIGHT, // 	The aspect ratio. Default is 1.
    0.1, //	The camera's near plane.Default is 0.1.
    2000, // The camera's far plane. Default is 2000.
  );
  camera.position.set(
    0, 
    0,
    0
  );
  camera.lookAt(new THREE.Vector3(
    0,
    0,
    1
  ));
  scene.add(camera);

  // Simple lighting for VRM
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(1, 1, 1);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 1));

  const clock = new THREE.Clock();

  return { renderer, scene, camera, clock };
}

/**
 * Load a VRM avatar using the dedicated VRM library (@pixiv/three-vrm).
 */
function loadVrm(
  scene: THREE.Scene,
  vrmRef: React.MutableRefObject<VRM | null>,
  setStatus: React.Dispatch<React.SetStateAction<UiStatus>>
): Promise<void> {
  setStatus((s) => ({ ...s, vrm: "loading" }));

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  return new Promise<void>((resolve, reject) => {
    loader.load(
      "avatar_D_00.vrm",
      (gltf) => {
        const vrm = gltf.userData.vrm as VRM;

        // Clean up VRM scene for better performance and orientation.
        VRMUtils.removeUnnecessaryJoints(vrm.scene);
        VRMUtils.rotateVRM0(vrm);

        // Face the camera and position the avatar a bit lower.
        vrm.scene.rotation.y = 0;
        vrm.scene.position.set(
          0, 
          0,
          2);

        scene.add(vrm.scene);
        vrmRef.current = vrm;

        setStatus((s) => ({ ...s, vrm: "ready" }));
        resolve();
      },
      undefined,
      (error) => {
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

function getHumanoidBone(
  humanoid: any,
  boneName: string
): THREE.Object3D | null {
  if (!humanoid) return null;

  // normalized born
  if (typeof humanoid.getNormalizedBoneNode === "function") {
    const n = humanoid.getNormalizedBoneNode(boneName);
    if (n) return n;
  }

  // raw born
  if (typeof humanoid.getRawBoneNode === "function") {
    const r = humanoid.getRawBoneNode(boneName);
    if (r) return r;
  }

  // old APIs（deprecated）
  if (typeof humanoid.getBoneNode === "function") {
    const legacy = humanoid.getBoneNode(boneName);
    if (legacy) return legacy;
  }

  return null;
}


/**
 * Apply Kalidokit results to a VRM avatar.
 * This uses the dedicated VRM humanoid rig from @pixiv/three-vrm.
 */
function applyKalidokitToVrm(vrm: VRM, results: any) {
  const pose3D = results.poseWorldLandmarks;
  const pose2D = results.poseLandmarks;
  const faceLandmarks = results.faceLandmarks;
  const leftHandLandmarks = results.leftHandLandmarks;
  const rightHandLandmarks = results.rightHandLandmarks;

  let riggedPose: any = null;
  let riggedFace: any = null;
  let riggedLeftHand: any = null;
  let riggedRightHand: any = null;

  // --- Pose (body) ---------------------------------------------------------
  const has2D = isValidLandmarkArray(pose2D, 33);
  const has3D = isValidLandmarkArray(pose3D, 33);

  if (has2D) {
    try {
      const worldForSolve = has3D ? pose3D : pose2D;
      riggedPose = Kalidokit.Pose.solve(worldForSolve, pose2D, {
        runtime: "mediapipe",
        video: undefined,
      });
    } catch (e) {
      console.warn("Kalidokit Pose.solve failed", e);
      riggedPose = null;
    }
  }

  // --- Face ---------------------------------------------------------------
  if (isValidLandmarkArray(faceLandmarks, 468)) {
    try {
      riggedFace = Kalidokit.Face.solve(faceLandmarks, {
        runtime: "mediapipe",
        video: undefined,
      });
    } catch (e) {
      console.warn("Kalidokit Face.solve failed", e);
      riggedFace = null;
    }
  }

  // --- Hands --------------------------------------------------------------
  if (isValidLandmarkArray(leftHandLandmarks, 21)) {
    try {
      riggedLeftHand = Kalidokit.Hand.solve(leftHandLandmarks, "Left");
    } catch (e) {
      console.warn("Kalidokit Hand.solve (Left) failed", e);
      riggedLeftHand = null;
    }
  }

  if (isValidLandmarkArray(rightHandLandmarks, 21)) {
    try {
      riggedRightHand = Kalidokit.Hand.solve(rightHandLandmarks, "Right");
    } catch (e) {
      console.warn("Kalidokit Hand.solve (Right) failed", e);
      riggedRightHand = null;
    }
  }

  // If nothing solved this frame, we do not modify the avatar.
  if (!riggedPose && !riggedFace && !riggedLeftHand && !riggedRightHand) {
    return;
  }

  const humanoid: any = (vrm as any).humanoid;
  if (!humanoid) return;

  // --- Body / pose --------------------------------------------------------
  if (riggedPose) {
    const hips = getHumanoidBone(humanoid, "hips");
    if (hips && riggedPose.Hips) {
      // Hips have position / rotation 
      if (riggedPose.Hips.position) {
        rigPosition(hips, riggedPose.Hips.position, 1, 0.07);
      }
      if (riggedPose.Hips.rotation) {
        rigRotation(hips, riggedPose.Hips.rotation, 1, 0.15);
      }
    }

    const spine = getHumanoidBone(humanoid, "spine");
    const chest = getHumanoidBone(humanoid, "chest");
    if (spine && riggedPose.Spine) {
      // Spine {x,y,z} 
      rigRotation(spine, riggedPose.Spine, 0.25, 0.3);
    }
    if (chest && riggedPose.Chest) {
      // Chest  {x,y,z}
      rigRotation(chest, riggedPose.Chest, 0.25, 0.3);
    }

    const neck = getHumanoidBone(humanoid, "neck");
    if (neck && (riggedPose.Neck || riggedPose.Head)) {
      // Neck or Head
      const neckRot =
        (riggedPose as any).Neck ||
        (riggedPose as any).Head ||
        null;
      if (neckRot) {
        rigRotation(neck, neckRot, 0.5, 0.3);
      }
    }

    // --- Arms -------------------------------------------------------------
    const leftUpperArm = getHumanoidBone(humanoid, "leftUpperArm");
    const leftLowerArm = getHumanoidBone(humanoid, "leftLowerArm");
    const leftHandFromPose = getHumanoidBone(humanoid, "leftHand");
    const rightUpperArm = getHumanoidBone(humanoid, "rightUpperArm");
    const rightLowerArm = getHumanoidBone(humanoid, "rightLowerArm");
    const rightHandFromPose = getHumanoidBone(humanoid, "rightHand");

    if (leftUpperArm && riggedPose.LeftUpperArm) {
      rigRotation(leftUpperArm, riggedPose.LeftUpperArm, 1, 0.3);
    }
    if (leftLowerArm && riggedPose.LeftLowerArm) {
      rigRotation(leftLowerArm, riggedPose.LeftLowerArm, 1, 0.3);
    }
    if (leftHandFromPose && riggedPose.LeftHand) {
      rigRotation(leftHandFromPose, riggedPose.LeftHand, 1, 0.3);
    }

    if (rightUpperArm && riggedPose.RightUpperArm) {
      rigRotation(rightUpperArm, riggedPose.RightUpperArm, 1, 0.3);
    }
    if (rightLowerArm && riggedPose.RightLowerArm) {
      rigRotation(rightLowerArm, riggedPose.RightLowerArm, 1, 0.3);
    }
    if (rightHandFromPose && riggedPose.RightHand) {
      rigRotation(rightHandFromPose, riggedPose.RightHand, 1, 0.3);
    }

    // --- Legs -------------------------------------------------------------
    const leftUpperLeg = getHumanoidBone(humanoid, "leftUpperLeg");
    const leftLowerLeg = getHumanoidBone(humanoid, "leftLowerLeg");
    const leftFoot = getHumanoidBone(humanoid, "leftFoot");
    const rightUpperLeg = getHumanoidBone(humanoid, "rightUpperLeg");
    const rightLowerLeg = getHumanoidBone(humanoid, "rightLowerLeg");
    const rightFoot = getHumanoidBone(humanoid, "rightFoot");

    if (leftUpperLeg && riggedPose.LeftUpperLeg) {
      rigRotation(leftUpperLeg, riggedPose.LeftUpperLeg, 1, 0.3);
    }
    if (leftLowerLeg && riggedPose.LeftLowerLeg) {
      rigRotation(leftLowerLeg, riggedPose.LeftLowerLeg, 1, 0.3);
    }
    if (leftFoot && riggedPose.LeftFoot) {
      rigRotation(leftFoot, riggedPose.LeftFoot, 1, 0.3);
    }

    if (rightUpperLeg && riggedPose.RightUpperLeg) {
      rigRotation(rightUpperLeg, riggedPose.RightUpperLeg, 1, 0.3);
    }
    if (rightLowerLeg && riggedPose.RightLowerLeg) {
      rigRotation(rightLowerLeg, riggedPose.RightLowerLeg, 1, 0.3);
    }
    if (rightFoot && riggedPose.RightFoot) {
      rigRotation(rightFoot, riggedPose.RightFoot, 1, 0.3);
    }
  }

  // --- Hands (Hand.solve → wrist rotation) -----------------------------
  if (riggedLeftHand) {
    const leftHand = getHumanoidBone(humanoid, "leftHand");
    // Kalidokit.Hand.solve: LeftWrist / RightWrist
    const leftWristRot = (riggedLeftHand as any).LeftWrist;
    if (leftHand && leftWristRot) {
      rigRotation(leftHand, leftWristRot, 1, 0.3);
    }
  }

  if (riggedRightHand) {
    const rightHand = getHumanoidBone(humanoid, "rightHand");
    const rightWristRot = (riggedRightHand as any).RightWrist;
    if (rightHand && rightWristRot) {
      rigRotation(rightHand, rightWristRot, 1, 0.3);
    }
  }

  // --- Face (head rotation only) -----------------------------------------
  if (riggedFace) {
    const headBone = getHumanoidBone(humanoid, "head");

    const faceHead =
      (riggedFace as any).head ||
      ((riggedFace as any).Head &&
        (riggedFace as any).Head.rotation);

    if (headBone && faceHead) {
      rigRotation(headBone, faceHead, 0.7, 0.3);
    }
  }
}


/**
 * Main React Native screen.
 * On web:
 *   Web camera -> MediaPipe Holistic -> Kalidokit -> VRM (via @pixiv/three-vrm).
 */
const HomeScreen: React.FC = () => {
  const [status, setStatus] = useState<UiStatus>({
    camera: "idle",
    holistic: "idle",
    tracking: "idle",
    vrm: "idle",
    error: undefined,
  });

  const threeRef = useRef<ThreeContext | null>(null);
  const vrmRef = useRef<VRM | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (Platform.OS !== "web") {
      return;
    }

    let cancelled = false;
    let holistic: any = null;
    let camera: any = null;

    const video = document.getElementById("input-video") as
      | HTMLVideoElement
      | null;
    const overlay = document.getElementById(
      "landmark-overlay"
    ) as HTMLCanvasElement | null;
    const vrmCanvas = document.getElementById(
      "vrm-canvas"
    ) as HTMLCanvasElement | null;

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

    // --- Setup three.js scene for VRM --------------------------------------
    const three = setupThree(vrmCanvas);
    threeRef.current = three;

    // --- Load VRM avatar (dedicated VRM library) ---------------------------
    loadVrm(three.scene, vrmRef, setStatus).catch((err) => {
      console.error("VRM load error", err);
    });

    // --- Camera + MediaPipe Holistic + Kalidokit pipeline -----------------
    async function initCameraAndHolistic() {
      try {
        setStatus((s) => ({ ...s, camera: "initializing", holistic: "idle" }));

        await loadCameraUtilsFromCdn();
        const HolisticCtor = await loadHolisticFromCdn();

        if (cancelled) return;

        holistic = new HolisticCtor({
          locateFile: (file: string) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5/${file}`,
        });

        holistic.setOptions({
          modelComplexity: 1,
          smoothLandmarks: true,
          enableSegmentation: false,
          refineFaceLandmarks: true,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });

        holistic.onResults((results: any) => {
          if (cancelled) return;

          if (ctx2d) {
            ctx2d.save();
            ctx2d.clearRect(0, 0, overlay.width, overlay.height);
            if (
              results.poseLandmarks &&
              Array.isArray(results.poseLandmarks) &&
              results.poseLandmarks.length
            ) {
              drawPoseOnCanvas(ctx2d, results.poseLandmarks);
            }
            ctx2d.restore();
          }

          if (vrmRef.current) {
            try {
              applyKalidokitToVrm(vrmRef.current, results);
              setStatus((s) => ({ ...s, tracking: "running" }));
            } catch (err) {
              console.warn("Pose / retargeting failed", err);
              setStatus((s) => ({
                ...s,
                tracking: "error",
                error: "Kalidokit pose / retargeting error",
              }));
            }
          }
        });

        setStatus((s) => ({ ...s, holistic: "initializing" }));

        const CameraCtor = (window as any).Camera;
        if (!CameraCtor) {
          throw new Error("MediaPipe Camera helper is not available");
        }

        camera = new CameraCtor(video, {
          onFrame: async () => {
            if (cancelled) return;
            try {
              await holistic.send({ image: video });
            } catch (err) {
              console.warn("Holistic send failed", err);
            }
          },
          width: VIDEO_WIDTH,
          height: VIDEO_HEIGHT,
        });

        setStatus((s) => ({
          ...s,
          camera: "running",
          holistic: "running",
          tracking: "running",
        }));

        await camera.start();
      } catch (err: any) {
        console.error("Failed to initialize tracking / 3D", err);
        setStatus((s) => ({
          ...s,
          camera: "error",
          holistic: "error",
          tracking: "error",
          error: String(err?.message || err),
        }));
      }
    }

    initCameraAndHolistic();

    // --- Three.js render loop ---------------------------------------------
    const renderLoop = () => {
      if (cancelled || !threeRef.current) return;

      const { renderer, scene, camera: threeCamera, clock } = threeRef.current;
      const deltaTime = clock.getDelta();

      if (vrmRef.current) {
        vrmRef.current.update(deltaTime);
      }

      renderer.render(scene, threeCamera);
      requestAnimationFrame(renderLoop);
    };

    requestAnimationFrame(renderLoop);

    return () => {
      cancelled = true;

      if (camera && typeof camera.stop === "function") {
        try {
          camera.stop();
        } catch {
          // ignore
        }
      }

      if (holistic && typeof holistic.close === "function") {
        try {
          holistic.close();
        } catch {
          // ignore
        }
      }

      const stream = streamRef.current;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
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
        <Text style={styles.title}>
          Web camera to VRM demo is only supported on the web.
        </Text>
      </View>
    );
  }

  const REPO_URL = "https://github.com/europanite/webcam_to_avatar";

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <TouchableOpacity onPress={() => Linking.openURL(REPO_URL)}>
        <Text
          style={{
            fontSize: 24,
            fontWeight: "800",
            marginBottom: 12,
            color: "#ffffffff",
            textDecorationLine: "underline",
          }}
        >
          WebCam to VRM
        </Text>
      </TouchableOpacity>

      <View style={styles.row}>
        <View style={styles.column}>
          <Text style={styles.sectionTitle}>Camera / pose preview</Text>

          <View style={styles.cameraMirrorWrapper}>
            <video
              id="input-video"
              style={styles.video as any}
              autoPlay
              playsInline
              muted
            />
            <canvas
              id="landmark-overlay"
              style={styles.overlay as any}
              width={VIDEO_WIDTH}
              height={VIDEO_HEIGHT}
            />
          </View>
        </View>

        <View style={styles.column}>
          <Text style={styles.sectionTitle}>VRM avatar</Text>
            <canvas id="vrm-canvas" style={styles.vrmCanvas as any} />
        </View>
      </View>

      <View style={styles.statusBox}>
        <Text style={styles.statusLine}>Camera: {status.camera}</Text>
        <Text style={styles.statusLine}>Holistic: {status.holistic}</Text>
        <Text style={styles.statusLine}>Tracking: {status.tracking}</Text>
        <Text style={styles.statusLine}>VRM: {status.vrm}</Text>
        {status.error ? (
          <Text style={styles.statusError}>{status.error}</Text>
        ) : null}
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
    flexGrow: 1,
    backgroundColor: "#000000ff",
  },
  title: {
    fontSize: 20,
    fontWeight: "600",
    marginBottom: 8,
    color: "#ffffffff",
  },
  subtitle: {
    fontSize: 14,
    color: "#ffffffff",
    marginBottom: 16,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 16,
  } as any,
  column: {
    flex: 1,
    minWidth: 320,
  } as any,
  video: {
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    backgroundColor: "#ffffffff",
  },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    pointerEvents: "none",
  },
  vrmCanvas: {
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    backgroundColor: "#f0f0f0",
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "500",
    marginBottom: 8,
  },
  statusBox: {
    marginTop: 16,
  },
  statusLine: {
    fontSize: 12,
    color: "#ffffffff",
  },
  statusError: {
    fontSize: 12,
    color: "#b00020",
    marginTop: 4,
  },
  cameraMirrorWrapper: {
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    position: "relative",
    overflow: "hidden",
    transform: [{ scaleX: -1 }],
  } as any,
});

export default HomeScreen;
