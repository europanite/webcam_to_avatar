# [vre](https://github.com/europanite/vre "vre")

A Playground for controling a vroid avatar with detecting a user motion. 

---

##  🚀 PlayGround
 [vre](https://europanite.github.io/vre/)

---

##  ✨ Features


---

## 🧰 How It Works

---

## 🚀 Getting Started

### 1. Prerequisites
- [Docker Compose](https://docs.docker.com/compose/)

### 2. Build and start all services:

```bash
# set environment variables:
export REACT_NATIVE_PACKAGER_HOSTNAME=192.168.3.6

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