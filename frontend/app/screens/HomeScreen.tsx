// frontend/app/screens/HomeScreen.tsx

import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Platform } from "react-native";
import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-backend-webgl";
import * as posedetection from "@tensorflow-models/pose-detection";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

type Detector = posedetection.PoseDetector;
type Keypoint = posedetection.Keypoint;

type CameraStatus = "idle" | "initializing" | "ready" | "error";
type TrackingStatus = "idle" | "detecting" | "no-person";

/**
 * Simple web camera + overlay view (web only).
 * - <video id="camera-video" />
 * - <canvas id="camera-overlay" />
 */
const WebCameraView: React.FC = () => {
  if (Platform.OS !== "web") {
    return (
      <View style={styles.cameraFallback}>
        <Text style={styles.infoText}>
          Camera pose tracking is available on Web only.
        </Text>
      </View>
    );
  }

  // On web we can directly use DOM elements
  // eslint-disable-next-line react/no-unknown-property
  return (
    // @ts-ignore – allow div/video/canvas in TSX
    <div
      id="camera-container"
      style={{
        position: "relative",
        width: "100%",
        maxWidth: 480,
        aspectRatio: "3/4",
        margin: "0 auto",
        backgroundColor: "#000",
        overflow: "hidden",
        borderRadius: 12,
      }}
    >
      {/* Mirrored video (like a selfie mirror) */}
      {/* @ts-ignore */}
      <video
        id="camera-video"
        autoPlay
        playsInline
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: "scaleX(-1)", // mirror horizontally (display only)
        }}
      />
      {/* Skeleton overlay (we will mirror drawing in code) */}
      {/* @ts-ignore */}
      <canvas
        id="camera-overlay"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />
    </div>
  );
};

/**
 * Skeleton edges for visualization.
 */
const SKELETON_EDGES: Array<[string, string]> = [
  ["left_eye", "right_eye"],
  ["left_ear", "left_eye"],
  ["right_ear", "right_eye"],
  ["left_shoulder", "right_shoulder"],
  ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"],
  ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"],
  ["left_shoulder", "left_hip"],
  ["right_shoulder", "right_hip"],
  ["left_hip", "right_hip"],
  ["left_hip", "left_knee"],
  ["left_knee", "left_ankle"],
  ["right_hip", "right_knee"],
  ["right_knee", "right_ankle"],
];

/**
 * Draws a mirrored skeleton and keypoints on the overlay canvas.
 * The video element is mirrored with CSS (scaleX(-1)),
 * so here we also mirror horizontally by using x' = canvasWidth - x.
 */
function drawSkeletonOnCanvas(
  ctx: CanvasRenderingContext2D,
  keypoints: Keypoint[],
  canvasWidth: number,
  canvasHeight: number
) {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  const minScore = 0.3;

  const byName: Record<string, Keypoint> = {};
  keypoints.forEach((kp) => {
    if (!kp.name) return;
    if (typeof kp.score === "number" && kp.score >= minScore) {
      byName[kp.name] = kp;
    }
  });

  ctx.lineWidth = 3;
  ctx.strokeStyle = "#00ff88";
  ctx.fillStyle = "#00d0ff";

  // Draw edges (mirrored)
  SKELETON_EDGES.forEach(([a, b]) => {
    const kp1 = byName[a];
    const kp2 = byName[b];
    if (!kp1 || !kp2) return;

    const x1 = canvasWidth - kp1.x;
    const y1 = kp1.y;
    const x2 = canvasWidth - kp2.x;
    const y2 = kp2.y;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  });

  // Draw keypoints (mirrored)
  Object.values(byName).forEach((kp) => {
    const x = canvasWidth - kp.x;
    const y = kp.y;

    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  });
}

/**
 * Applies a full-body pose to a VRM humanoid based on a single-person pose.
 *
 * Coordinate conventions:
 * - MoveNet keypoints are in screen coordinates (origin = top-left).
 * - x increases to the right, y increases downward.
 * - We DO NOT mirror keypoints for VRM. Mirroring is only for drawing
 *   on the canvas. Left/right use MoveNet's "left_*" / "right_*"
 *   (subject’s perspective).
 */
function applyPoseToVRMFromKeypoints(vrm: any, keypoints: Keypoint[]) {
  if (!vrm || !vrm.humanoid) return;

  const humanoid = vrm.humanoid;

  // Collect keypoints by name with a minimum score threshold
  const byName: Record<string, Keypoint> = {};
  keypoints.forEach((kp) => {
    if (!kp.name) return;
    if (typeof kp.score === "number" && kp.score >= 0.3) {
      byName[kp.name] = kp;
    }
  });

  const getPoint = (name: string) => byName[name];

  const leftShoulder = getPoint("left_shoulder");
  const rightShoulder = getPoint("right_shoulder");
  const leftElbow = getPoint("left_elbow");
  const rightElbow = getPoint("right_elbow");
  const leftWrist = getPoint("left_wrist");
  const rightWrist = getPoint("right_wrist");

  const leftHip = getPoint("left_hip");
  const rightHip = getPoint("right_hip");
  const leftKnee = getPoint("left_knee");
  const rightKnee = getPoint("right_knee");
  const leftAnkle = getPoint("left_ankle");
  const rightAnkle = getPoint("right_ankle");

  const nose = getPoint("nose");
  const leftEye = getPoint("left_eye");
  const rightEye = getPoint("right_eye");

  // At least torso is required. If not present, do nothing.
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) {
    return;
  }

  const getBone = (boneName: string): THREE.Object3D | null => {
    try {
      // Use getNormalizedBoneNode to avoid deprecated getBoneNode()
      const node = humanoid.getNormalizedBoneNode(
        boneName as any
      ) as THREE.Object3D | null | undefined;
      return node ?? null;
    } catch {
      return null;
    }
  };

  const hips = getBone("hips");
  const spine = getBone("spine");
  const chest = getBone("chest");
  const neck = getBone("neck");
  const head = getBone("head");

  const leftUpperArm = getBone("leftUpperArm");
  const leftLowerArm = getBone("leftLowerArm");
  const leftHand = getBone("leftHand");
  const rightUpperArm = getBone("rightUpperArm");
  const rightLowerArm = getBone("rightLowerArm");
  const rightHand = getBone("rightHand");

  const leftUpperLeg = getBone("leftUpperLeg");
  const leftLowerLeg = getBone("leftLowerLeg");
  const leftFoot = getBone("leftFoot");
  const rightUpperLeg = getBone("rightUpperLeg");
  const rightLowerLeg = getBone("rightLowerLeg");
  const rightFoot = getBone("rightFoot");

  const clamp = (v: number, min: number, max: number) =>
    Math.max(min, Math.min(max, v));

  const v2 = (ax: number, ay: number, bx: number, by: number) => {
    return { x: bx - ax, y: by - ay };
  };

  const angle2D = (ax: number, ay: number, bx: number, by: number) =>
    Math.atan2(by - ay, bx - ax); // radians

  // ------------------------
  // 1. Torso orientation
  // ------------------------
  const shoulderMid = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };
  const hipMid = {
    x: (leftHip.x + rightHip.x) / 2,
    y: (leftHip.y + rightHip.y) / 2,
  };

  const torsoVec = v2(hipMid.x, hipMid.y, shoulderMid.x, shoulderMid.y);
  let torsoAngle = Math.atan2(torsoVec.y, torsoVec.x); // 0 = right, PI/2 = down
  // Upright is roughly pointing from hips to shoulders, slightly upwards.
  // Convert to a pitch (forward/backward) around X axis.
  let torsoPitch = -(torsoAngle - Math.PI / 2);
  torsoPitch = clamp(torsoPitch, -0.6, 0.6);

  if (hips) {
    hips.rotation.x = torsoPitch * 0.3;
  }
  if (spine) {
    spine.rotation.x = torsoPitch * 0.5;
  }
  if (chest) {
    chest.rotation.x = torsoPitch * 0.7;
  }

  // ------------------------
  // 2. Head & neck orientation
  // ------------------------
  if (head && leftEye && rightEye && nose) {
    const eyeCenter = {
      x: (leftEye.x + rightEye.x) / 2,
      y: (leftEye.y + rightEye.y) / 2,
    };

    // Yaw (左右回転): based on horizontal difference between left/right eye
    const eyeDx = rightEye.x - leftEye.x;
    let yaw = eyeDx * 0.01; // heuristic scale
    yaw = clamp(yaw, -0.5, 0.5);

    // Pitch (上下): nose position relative to eye center
    const eyeToNose = v2(eyeCenter.x, eyeCenter.y, nose.x, nose.y);
    let pitch = eyeToNose.y * 0.01; // nose below eyes => looking down
    pitch = clamp(pitch, -0.4, 0.4);

    // VRM is facing +Z, camera is in front; adjust signs
    head.rotation.y = -yaw;
    head.rotation.x = -pitch;

    if (neck) {
      neck.rotation.y = head.rotation.y * 0.5;
      neck.rotation.x = head.rotation.x * 0.5;
    }
  }

  // ------------------------
  // 3. Arms (upper + lower + hand)
  // ------------------------
  const applyArmChain = (
    isLeft: boolean,
    upper: THREE.Object3D | null,
    lower: THREE.Object3D | null,
    hand: THREE.Object3D | null,
    shoulder?: Keypoint,
    elbow?: Keypoint,
    wrist?: Keypoint
  ) => {
    if (!upper || !shoulder || !elbow) return;

    // Vector from shoulder to elbow
    const seAngle = angle2D(shoulder.x, shoulder.y, elbow.x, elbow.y);
    // When arm is hanging down vertically, angle is ~ PI/2.
    // Convert to "side raise" around Z axis.
    let sideRaise = seAngle - Math.PI / 2;
    // Mirror for right vs left so that positive is "arm up to the side"
    if (!isLeft) sideRaise = -sideRaise;
    sideRaise = clamp(sideRaise, -(Math.PI / 2), Math.PI / 2);

    upper.rotation.z = sideRaise;

    // Lower arm (elbow bend) based on angle elbow→wrist relative to shoulder→elbow
    if (lower && wrist) {
      const ewAngle = angle2D(elbow.x, elbow.y, wrist.x, wrist.y);
      let elbowBend = ewAngle - seAngle;
      // Bend inward is positive, clamp to a reasonable range
      elbowBend = clamp(elbowBend, -Math.PI / 2, Math.PI / 2);
      // Use X axis to represent bending
      lower.rotation.x = elbowBend;
    }

    // Hand: follow lower arm a bit so that the "end effector" moves
    if (hand && lower) {
      hand.rotation.x = (lower.rotation.x ?? 0) * 0.7;
      hand.rotation.z = (upper.rotation.z ?? 0) * 0.5;
    }
  };

  applyArmChain(
    true,
    leftUpperArm,
    leftLowerArm,
    leftHand,
    leftShoulder,
    leftElbow,
    leftWrist
  );
  applyArmChain(
    false,
    rightUpperArm,
    rightLowerArm,
    rightHand,
    rightShoulder,
    rightElbow,
    rightWrist
  );

  // ------------------------
  // 4. Legs (upper + lower + foot)
  // ------------------------
  const applyLegChain = (
    upper: THREE.Object3D | null,
    lower: THREE.Object3D | null,
    foot: THREE.Object3D | null,
    hip?: Keypoint,
    knee?: Keypoint,
    ankle?: Keypoint
  ) => {
    if (!upper || !hip || !knee) return;

    // Hip → knee vector
    const hkAngle = angle2D(hip.x, hip.y, knee.x, knee.y);
    // When standing straight, leg direction ~ PI/2 (down).
    let upperPitch = hkAngle - Math.PI / 2;
    // Standing, walking程度の範囲に制限
    upperPitch = clamp(upperPitch, -0.8, 0.8);
    upper.rotation.x = upperPitch;

    if (lower && ankle) {
      // Knee → ankle vector
      const kaAngle = angle2D(knee.x, knee.y, ankle.x, ankle.y);
      let kneeBend = kaAngle - hkAngle;
      kneeBend = clamp(kneeBend, -0.1, 1.2);
      lower.rotation.x = kneeBend;
    }

    if (foot && lower) {
      // 足首はスネの回転に少し追従させる
      foot.rotation.x = (lower.rotation.x ?? 0) * 0.6;
    }
  };

  applyLegChain(
    leftUpperLeg,
    leftLowerLeg,
    leftFoot,
    leftHip,
    leftKnee,
    leftAnkle
  );
  applyLegChain(
    rightUpperLeg,
    rightLowerLeg,
    rightFoot,
    rightHip,
    rightKnee,
    rightAnkle
  );
}

/**
 * Main screen component.
 */
const HomeScreen: React.FC = () => {
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>("idle");
  const [trackingStatus, setTrackingStatus] =
    useState<TrackingStatus>("idle");
  const [tfReady, setTfReady] = useState(false);

  const detectorRef = useRef<Detector | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const threeSceneRef = useRef<THREE.Scene | null>(null);
  const threeCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const threeRendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const vrmRef = useRef<any | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const rafIdRef = useRef<number | null>(null);

  /**
   * Initialize TensorFlow.js and pose detector.
   */
  useEffect(() => {
    let cancelled = false;

    const initTfAndDetector = async () => {
      try {
        await tf.setBackend("webgl");
        await tf.ready();
        if (cancelled) return;

        const detector = await posedetection.createDetector(
          posedetection.SupportedModels.MoveNet,
          {
            // Use the more accurate MoveNet SinglePose Thunder model
            modelType:
              (posedetection.movenet &&
                posedetection.movenet.modelType &&
                posedetection.movenet.modelType.SINGLEPOSE_THUNDER) ||
              "SinglePose.Thunder",
          } as posedetection.MoveNetModelConfig
        );

        if (cancelled) return;

        detectorRef.current = detector;
        setTfReady(true);
      } catch (err) {
        console.error("Failed to initialize TF / detector:", err);
      }
    };

    if (Platform.OS === "web") {
      initTfAndDetector();
    }

    return () => {
      cancelled = true;
      if (detectorRef.current) {
        detectorRef.current.dispose();
        detectorRef.current = null;
      }
    };
  }, []);

  /**
   * Initialize web camera.
   */
  useEffect(() => {
    if (Platform.OS !== "web") return;

    const video = document.getElementById(
      "camera-video"
    ) as HTMLVideoElement | null;
    const canvas = document.getElementById(
      "camera-overlay"
    ) as HTMLCanvasElement | null;

    videoRef.current = video;
    overlayCanvasRef.current = canvas;

    if (!video || !canvas) {
      console.warn("Camera video/canvas element not found");
      return;
    }

    setCameraStatus("initializing");

    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: 640 },
            height: { ideal: 480 },
          },
          audio: false,
        });

        video.srcObject = stream;

        await new Promise<void>((resolve) => {
          if (video.readyState >= 2) {
            resolve();
          } else {
            video.onloadedmetadata = () => resolve();
          }
        });

        video.play().catch((err) => {
          console.error("video.play() failed:", err);
        });

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        setCameraStatus("ready");
      } catch (err) {
        console.error("Failed to start camera:", err);
        setCameraStatus("error");
      }
    };

    startCamera();

    return () => {
      if (video && video.srcObject) {
        const stream = video.srcObject as MediaStream;
        stream.getTracks().forEach((t) => t.stop());
        video.srcObject = null;
      }
    };
  }, []);

  /**
   * Initialize three.js scene and VRM avatar.
   */
  useEffect(() => {
    if (Platform.OS !== "web") return;

    // @ts-ignore
    const container = document.getElementById(
      "three-container"
    ) as HTMLDivElement | null;
    if (!container) {
      console.warn("three-container not found");
      return;
    }

    const scene = new THREE.Scene();
    threeSceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / 400,
      0.1,
      100
    );
    camera.position.set(0, 1.3, 3);
    threeCameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
    });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(container.clientWidth, 400);
    renderer.outputEncoding = THREE.sRGBEncoding;
    container.innerHTML = "";
    container.appendChild(renderer.domElement);
    threeRendererRef.current = renderer;

    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(1, 1, 2);
    scene.add(dirLight);
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));

    const grid = new THREE.GridHelper(4, 4);
    grid.position.y = -0.9;
    scene.add(grid);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const avatarUrl = "/avatar.vrm";

    loader.load(
      avatarUrl,
      (gltf) => {
        // This is deprecated but still works; it just shows a warning.
        VRMUtils.removeUnnecessaryJoints(gltf.scene);

        const vrm = gltf.userData.vrm;
        vrmRef.current = vrm;

        vrm.scene.traverse((obj: THREE.Object3D) => {
          obj.frustumCulled = false;
        });

        // Make the avatar face the camera (foreground)
        vrm.scene.position.set(0, -0.8, 0);
        vrm.scene.rotation.y = 0; // face forward
        vrm.scene.scale.setScalar(1.0);

        scene.add(vrm.scene);
      },
      undefined,
      (err) => {
        console.error("Failed to load VRM:", err);
      }
    );

    const onResize = () => {
      if (!container || !camera || !renderer) return;
      const w = container.clientWidth;
      const h = 400;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

    window.addEventListener("resize", onResize);

    const renderLoop = (time: number) => {
      const dt = (time - (lastFrameTimeRef.current || time)) / 1000;
      lastFrameTimeRef.current = time;

      if (vrmRef.current && typeof vrmRef.current.update === "function") {
        vrmRef.current.update(dt);
      }

      renderer.render(scene, camera);
      rafIdRef.current = requestAnimationFrame(renderLoop);
    };

    rafIdRef.current = requestAnimationFrame(renderLoop);

    return () => {
      window.removeEventListener("resize", onResize);
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      if (renderer) {
        renderer.dispose();
        if (renderer.domElement && renderer.domElement.parentElement) {
          renderer.domElement.parentElement.removeChild(renderer.domElement);
        }
      }
    };
  }, []);

  /**
   * Main tracking loop:
   * - Estimate pose
   * - Draw mirrored skeleton on overlay
   * - Apply pose to VRM
   */
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!tfReady) return;

    let cancelled = false;

    const loop = async () => {
      const detector = detectorRef.current;
      const video = videoRef.current;
      const canvas = overlayCanvasRef.current;

      if (!detector || !video || !canvas) {
        if (!cancelled) {
          rafIdRef.current = requestAnimationFrame(loop);
        }
        return;
      }

      try {
        setTrackingStatus("detecting");

        const poses = await detector.estimatePoses(video, {
          maxPoses: 1,
          // IMPORTANT:
          //   flipHorizontal is false here.
          //   - The video is visually mirrored with CSS.
          //   - The model still "sees" the original orientation.
          //   - We only mirror for drawing on the canvas; VRM uses original keypoints.
          flipHorizontal: false,
        });

        const pose = poses[0];

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        if (!pose || !pose.keypoints || pose.keypoints.length === 0) {
          setTrackingStatus("no-person");
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        } else {
          const keypoints = pose.keypoints as Keypoint[];

          // Mirrored drawing on the canvas (to match mirrored video)
          drawSkeletonOnCanvas(ctx, keypoints, canvas.width, canvas.height);

          if (vrmRef.current) {
            // NOTE: We use the original (non-mirrored) keypoints for VRM.
            applyPoseToVRMFromKeypoints(vrmRef.current, keypoints);
          }
        }
      } catch (err) {
        console.error("Pose detection loop error:", err);
      }

      if (!cancelled) {
        rafIdRef.current = requestAnimationFrame(loop);
      }
    };

    rafIdRef.current = requestAnimationFrame(loop);

    return () => {
      cancelled = true;
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [tfReady]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Web Camera VRM Tracker (MoveNet)</Text>

      <View style={styles.statusRow}>
        <Text style={styles.statusLabel}>Camera:</Text>
        <Text style={styles.statusValue}>{cameraStatus}</Text>
      </View>
      <View style={styles.statusRow}>
        <Text style={styles.statusLabel}>Tracking:</Text>
        <Text style={styles.statusValue}>{trackingStatus}</Text>
      </View>

      {/* Camera (left) + Avatar (right) */}
      <View style={styles.mainRow}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>1. Camera & Skeleton</Text>
          <WebCameraView />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>2. VRM Avatar</Text>
          {Platform.OS === "web" ? (
            // @ts-ignore
            <div
              id="three-container"
              style={{
                width: "100%",
                height: 400,
                maxWidth: 480,
                margin: "16px auto",
                borderRadius: 12,
                overflow: "hidden",
                background:
                  "radial-gradient(circle at top, #222 0%, #000 60%, #000 100%)",
              }}
            />
          ) : (
            <View style={styles.cameraFallback}>
              <Text style={styles.infoText}>
                VRM rendering is available on Web only.
              </Text>
            </View>
          )}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notes</Text>
        <Text style={styles.infoText}>
          - The tracking overlay is mirrored, so when you raise your right hand,
          the overlay moves on the same side as in a mirror.{"\n"}
          - The avatar is rotated to face the camera (foreground).{"\n"}
          - VRMUtils.removeUnnecessaryJoints is deprecated but still works; it
          just shows a warning.{"\n"}
          - Left/right and up/down definitions for VRM are aligned with
          MoveNet screen coordinates (subject’s perspective).{"\n"}
          - Arms, legs, and head are now roughly synchronized with your pose.{"\n"}
        </Text>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 40,
    backgroundColor: "#050510",
    minHeight: "100%",
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
    color: "#ffffff",
    textAlign: "center",
    marginBottom: 16,
  },
  statusRow: {
    flexDirection: "row",
    justifyContent: "center",
    marginBottom: 4,
  },
  statusLabel: {
    fontSize: 14,
    color: "#888888",
    marginRight: 4,
  },
  statusValue: {
    fontSize: 14,
    color: "#ffffff",
  },
  mainRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "flex-start",
    marginTop: 16,
    flexWrap: "wrap", // If the screen is narrow, they will stack
  },
  section: {
    marginTop: 16,
    flex: 1,
    minWidth: 280,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#ffffff",
    marginBottom: 8,
    textAlign: "center",
  },
  cameraFallback: {
    padding: 16,
    borderRadius: 12,
    backgroundColor: "#111",
  },
  infoText: {
    fontSize: 13,
    color: "#cccccc",
    lineHeight: 18,
  },
});

export default HomeScreen;
