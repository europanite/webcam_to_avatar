# [WebCam to Avartar](https://github.com/europanite/vre "WebCam to Avartar")

[![CI](https://github.com/europanite/webcam_to_avatar/actions/workflows/ci.yml/badge.svg)](https://github.com/europanite/webcam_to_avatar/actions/workflows/ci.yml)
[![docker](https://github.com/europanite/webcam_to_avatar/actions/workflows/docker.yml/badge.svg)](https://github.com/europanite/webcam_to_avatar/actions/workflows/docker.yml)
[![GitHub Pages](https://github.com/europanite/webcam_to_avatar/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/europanite/webcam_to_avatar/actions/workflows/deploy-pages.yml)

!["web_ui"](./assets/images/web_ui.png)

[PlayGround](https://europanite.github.io/webcam_to_avatar/)

A Playground to controle a vroid avatar with user pose estimation.

---

## ✨ Features

- **Real-time avatar control**  
  - Uses MediaPipe **Holistic / Thunder** model as a pose detector.  
  - Tracks **body, face, and both hands** from the webcam feed.

- **VRoid / VRM support**  
  - Loads a VRoid avatar (`VRoid_Woman.vrm`) via `GLTFLoader` and `VRMLoaderPlugin`.  
  - Applies Kalidokit’s solved pose/face/hand data to the humanoid rig.

- **Runs entirely in the browser**  
  - No backend is required for pose estimation or avatar control.  
  - All processing stays on the client for privacy.

- **Expo + React Native for Web**  
  - Implemented as an Expo app and exported to static web.  
  - Easy to run in development mode on mobile or web.

- **Deterministic CI / Docker setup**  
  - Docker Compose configuration for local development and tests.  
  - GitHub Actions workflows for **CI**, **Docker tests**, and **GitHub Pages deployment**.

---

## 🧰 How It Works

At a high level, the pipeline is:

1. **Webcam capture**  
   - The browser captures your webcam stream (portrait-oriented, e.g. 480×640).  

2. **MediaPipe Holistic (Thunder)**  
   - Holistic is dynamically loaded from a CDN at runtime to avoid bundler issues like  
     `"Holistic is not a constructor"`.  
   - It produces:
     - 2D and 3D **pose landmarks**  
     - **Face landmarks**  
     - **Left / right hand landmarks**

3. **Kalidokit solving**  
   - Kalidokit consumes the landmarks and solves:
     - **RiggedPose** (body / hips / spine / limbs)  
     - **RiggedFace** (eyes, mouth, head rotation, etc.)  
     - **RiggedHand** for left and right hands  

4. **VRM rigging (Three.js + @pixiv/three-vrm)**  
   - A VRM avatar is loaded and normalized (using `VRMUtils.removeUnnecessaryJoints()` and `VRMUtils.rotateVRM0()`).  
   - The solved Kalidokit data is applied to the VRM humanoid bones (hips, spine, arms, fingers, etc.).  
   - A Three.js render loop updates the avatar every frame.

5. **UI / controls**  
   - A simple settings bar lets you:
     - Start/stop camera and tracking  
     - See status (camera / Holistic / VRM)  
     - Open links (e.g. repository, demo)

---

## 🏗️ Tech Stack

- **Frontend**
  - [Expo](https://expo.dev/) / React Native
  - React Native for Web
  - TypeScript / TSX

- **3D & Avatar**
  - [Three.js](https://threejs.org/)
  - [`@pixiv/three-vrm`](https://github.com/pixiv/three-vrm) for VRM avatars
  - `GLTFLoader` + `VRMLoaderPlugin`

- **Pose & Animation**
  - MediaPipe Holistic (**Thunder** model)
  - [Kalidokit](https://github.com/yeemachine/kalidokit) for rigging

- **Tooling / Infra**
  - Docker & Docker Compose
  - GitHub Actions (CI, Docker tests, GitHub Pages deployment)

---

## 🚀 Getting Started

### 1. Prerequisites
- [Docker Compose](https://docs.docker.com/compose/)

### 2. Build and start all services:

```bash
# set environment variables:
export REACT_NATIVE_PACKAGER_HOSTNAME=${YOUR_HOST}

# Build the image
docker compose build

# Run the container
docker compose up
```

### 3. Test:
```bash
docker compose \
-f docker-compose.test.yml up \
--build --exit-code-from \
frontend_test
```

---

# License
- Apache License 2.0