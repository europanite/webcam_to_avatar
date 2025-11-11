// VrmSpeaker.web.tsx
// Web専用: VRMモデルを描画して、"vrm-speak" イベントで喋っている間だけ口パクさせるコンポーネント

import React, { useEffect, useRef } from "react";
import { View, StyleSheet } from "react-native";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import { VRM, VRMLoaderPlugin } from "@pixiv/three-vrm";

const VRM_URL = "./avatar.vrm";

export const VrmSpeaker: React.FC = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const vrmRef = useRef<VRM | null>(null);
  const speakingRef = useRef(false);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // --- basic three.js setup ---
    const width = container.clientWidth || 400;
    const height = 400;

    const scene = new THREE.Scene();
    scene.background = null;
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(30.0, width / height, 0.1, 20.0);
    camera.position.set(0.0, 1.4, 3.0);
    camera.lookAt(0, 1.4, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const light = new THREE.DirectionalLight(0xffffff, 1.0);
    light.position.set(1.0, 1.0, 1.0);
    scene.add(light);

    const ambient = new THREE.AmbientLight(0xffffff, 0.3);
    scene.add(ambient);

    // --- VRM load ---
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader.load(
      VRM_URL,
      (gltf: any) => {
        const vrm = gltf.userData.vrm as VRM;
        if (!vrm) {
          console.error("No VRM data found in GLTF. Check that this is a .vrm file.");
          return;
        }

        // 正面向き:
        // VRM は多くの場合 -Z 向きが正面なので、そのまま使う。
        // （以前の Math.PI 回転を消しているのがポイント）
        vrm.scene.position.set(0, 0, 0);

        // 軽く待機ポーズにする（Tポーズから腕を少し下げる）
        const humanoid = vrm.humanoid;
        if (humanoid) {
          const leftUpperArm = humanoid.getNormalizedBoneNode("leftUpperArm");
          const rightUpperArm = humanoid.getNormalizedBoneNode("rightUpperArm");
          if (leftUpperArm) {
            leftUpperArm.rotation.z = -0.4; // 内側に少し下げる
          }
          if (rightUpperArm) {
            rightUpperArm.rotation.z = 0.4; // 内側に少し下げる
          }
        }

        scene.add(vrm.scene);
        vrmRef.current = vrm;

        startAnimationLoop();
      },
      undefined,
      (error) => {
        console.error("Failed to load VRM:", error);
      }
    );

    const clock = new THREE.Clock();

    const animate = () => {
      const deltaTime = clock.getDelta();

      if (vrmRef.current) {
        const vrm = vrmRef.current;
        const t = performance.now() / 1000;

        // まばたき
        const blink = (Math.sin(t * 3.0) + 1) / 2;
        vrm.expressionManager?.setValue("blink", blink);

        // 口パク（喋っている間だけ）
        if (speakingRef.current) {
          const mouth = (Math.sin(t * 10.0) + 1) / 2;
          vrm.expressionManager?.setValue("aa", mouth);
        } else {
          vrm.expressionManager?.setValue("aa", 0);
        }

        vrm.update(deltaTime);
      }

      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    const startAnimationLoop = () => {
      if (animationFrameRef.current == null) {
        animationFrameRef.current = requestAnimationFrame(animate);
      }
    };

    // --- speech event handler ---
    const handleSpeakEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail as { text?: string; lang?: string };
      const text = detail?.text ?? "";
      if (!text) return;

      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        console.warn("SpeechSynthesis API is not available in this environment.");
        return;
      }

      window.speechSynthesis.cancel();

      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = detail?.lang || "en-US"; // 日本語なら "ja-JP" を渡す

      utter.onstart = () => {
        speakingRef.current = true;
      };
      utter.onend = () => {
        speakingRef.current = false;
      };
      utter.onerror = () => {
        speakingRef.current = false;
      };

      window.speechSynthesis.speak(utter);
    };

    window.addEventListener("vrm-speak", handleSpeakEvent);

    // --- resize handler ---
    const handleResize = () => {
      if (!containerRef.current || !rendererRef.current || !cameraRef.current) return;
      const w = containerRef.current.clientWidth || 400;
      const h = 400;
      const camera = cameraRef.current;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      rendererRef.current.setSize(w, h);
    };

    window.addEventListener("resize", handleResize);

    // --- cleanup ---
    return () => {
      window.removeEventListener("vrm-speak", handleSpeakEvent);
      window.removeEventListener("resize", handleResize);

      if (animationFrameRef.current != null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }

      if (vrmRef.current) {
        try {
          vrmRef.current.dispose();
        } catch (e) {
          console.warn("Failed to dispose VRM:", e);
        }
        vrmRef.current = null;
      }

      if (sceneRef.current) {
        sceneRef.current.clear();
        sceneRef.current = null;
      }

      if (rendererRef.current) {
        rendererRef.current.dispose();
        if (rendererRef.current.domElement.parentNode) {
          rendererRef.current.domElement.parentNode.removeChild(
            rendererRef.current.domElement
          );
        }
        rendererRef.current = null;
      }
    };
  }, []);

  return <View style={styles.wrapper} ref={containerRef as any} />;
};

const styles = StyleSheet.create({
  wrapper: {
    width: "100%",
    height: 400,
    backgroundColor: "transparent"
  }
});

export default VrmSpeaker;
