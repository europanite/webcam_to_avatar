# [WebCam to Avartar](https://github.com/europanite/vre "WebCam to Avartar")

[![GitHub Pages](https://github.com/europanite/webcam_to_avatar/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/europanite/webcam_to_avatar/actions/workflows/deploy-pages.yml)

!["web_ui"](./assets/images/web_ui.png)

[PlayGround](https://europanite.github.io/webcam_to_avatar/)

A Playground to controle a vroid avatar with user pose estimation.

---

##  ✨ Features

- Use Thunder model as a pose detector.

---

## 🧰 How It Works

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