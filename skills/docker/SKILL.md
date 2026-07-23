---
name: docker
description: Build, run, ship, and debug containers well - small secure images, compose, GPU passthrough, registry push. Includes the neko sandbox gotcha.
match: (docker|dockerfile|docker-?compose|container(ize|ise)?|buildx|image.{0,20}(build|push|pull)|docker hub|registry|\.dockerignore|nvidia-?container)
---

# Docker — build small, ship reliably, debug fast

Use whenever a task involves containers: packaging an app, a reproducible env, a GPU service, or a
submission that must be a Docker image (e.g. a hackathon). Docker runs through `bash` against the
**Docker Desktop** daemon (on this Windows machine); the commands are ordinary CLI.

## FIRST: the neko sandbox gotcha (why docker may "not work")
On Windows, neko runs `bash` inside the **srt sandbox** (a low-priv user + restricted token). The Docker
CLI talks to Docker Desktop over the named pipe `\\.\pipe\docker_engine`, which the sandbox user usually
can't reach — so `docker ...` fails with **"error during connect / cannot connect to the Docker daemon"**
even though Docker Desktop is running fine. This is the difference from Claude Code / Codex (they run
bash unsandboxed).

If you hit that error:
- **Run the docker command unsandboxed** (it needs daemon access) - request approval for that one command
  rather than retrying in the sandbox, and say why. Docker talks to a local trusted daemon; it isn't the
  arbitrary-network risk the sandbox guards against.
- Confirm Docker Desktop is running first: `docker version` (client+server), `docker info`. Client-only
  output = the daemon isn't reachable (Desktop not started, or the sandbox is blocking the pipe).
- If it should be a permanent fix, the daemon pipe can be carved out of the sandbox / the sandbox user
  added to the `docker-users` group - flag that to the owner rather than doing it silently.

## Build a small, correct image
Enable BuildKit (default in modern Docker; `DOCKER_BUILDKIT=1` otherwise). Principles:
- **Multi-stage**: a `build` stage with the toolchain, a lean `runtime` stage that `COPY`s only the built
  artifact. Cuts image size 90%+ (400MB -> ~18MB is typical).
- **Small base**, pinned by digest/tag: `slim`, `alpine` (musl caveats), or **distroless** for runtime.
  For GPU/CUDA, base on the matching `nvidia/cuda:<ver>-runtime-<os>` (runtime, not devel, for the final stage).
- **Layer order for cache**: copy the dependency manifest and install deps BEFORE copying source, so a
  code change doesn't bust the dependency layer. Use BuildKit **cache mounts** (`RUN --mount=type=cache`)
  for package managers, and `COPY --link` for stable layers.
- **`.dockerignore`**: exclude `.git`, `node_modules`, tests, caches, secrets, build junk - smaller
  context, faster builds, no secret leaks.
- **Non-root**: create and `USER` a non-root account in the runtime stage.
- **`HEALTHCHECK`**: a real check (hit `/health` or the port) so orchestrators + graders know it's up.
- **Never bake secrets** into layers (they persist in history); pass at run time via env / `--secret`.
- Scan before shipping: `docker scout quickview` / `docker scan`.

## Run & compose
- `docker build -t name:tag .` · `docker run --rm -p 8000:8000 name:tag` · `docker logs -f`, `docker exec -it <c> sh`.
- **Compose** for multi-service or a declared run: `docker compose up --build`. Keep ports, env, volumes,
  and `deploy.resources` in `docker-compose.yml` (the single source of truth some graders require).
- **GPU**: needs the **NVIDIA Container Toolkit**. Run with `--gpus all` (or compose
  `deploy.resources.reservations.devices` with `driver: nvidia`). Verify inside the container with
  `nvidia-smi`. `shm_size` matters for ML frameworks (set `--shm-size` / `shm_size:` for PyTorch/vLLM).

## Ship to a registry (e.g. Docker Hub public)
`docker login` -> `docker tag name:tag user/name:tag` -> `docker push user/name:tag`. For a public
submission, confirm the repo is **public** and the exact `image:tag` in the compose file matches what you
pushed. Pin a specific tag/digest, not `latest`, so the graded image is the one you tested.

## Debug fast
`docker ps -a`, `docker logs <c>`, `docker exec -it <c> sh`, `docker inspect <c>`, `docker stats`. A
container that exits immediately: read the logs and the entrypoint. Build cache confusion: `--no-cache`
to isolate, then restore caching once fixed.

## Verify (the honest bar)
"It builds" is not "it works". **Actually run the container**, hit its healthcheck/endpoint, and read the
output - from a clean `docker build` (remove stale images/layers first). For a submission, do the cold
pull test: `docker pull` the pushed public image on a clean context and run it, so you prove the graded
artifact works off your machine, not just your local build cache.
