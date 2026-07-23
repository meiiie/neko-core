# DevOps — ship it, keep it shippable, don't lose the demo

A hackathon is won at the demo. DevOps here means one thing: **a trusted path from code to a working URL
that stays working.** Right-sized: the discipline of a top team, the scope of a weekend.

## Ship on day one (not hour 45)
- Get a **deployable skeleton live in the first hours** — an empty page or a `/health` 200 on a real URL.
  Discovering a build/deploy failure the night before the demo is the classic loss.
- Use a **zero-friction host** for the stack (see `golden-stacks.md`): Vercel/Netlify (web), Fly/Railway/
  Render (containers/APIs), a managed DB. Don't hand-roll infra you'll babysit.
- **Containerize if the runtime is non-trivial** (Docker) so "works on my machine" == "works on the
  judge's". A pinned base image + a lockfile removes a whole class of surprises.

## A small, honest pipeline
- Modular stages, each doing one job: **build → test → deploy**. Even a single GitHub Actions file that
  runs `typecheck`, tests, and deploys on push is enough — and it catches breakage before the stage does.
- **Deploy on green only.** Wire the verify loop (`SKILL.md` Stage 5) into CI so a red build never ships.
- **Re-deploy at every milestone**, not once at the end. Continuous small deploys surface problems while
  they're cheap.

## Config & secrets
- **Infrastructure/config as code or a checked-in template** (`.env.example`, a compose file) so the
  environment is reproducible, not tribal knowledge.
- Secrets in the host's env/secret store — **never committed** (Neko's own rule; run a secret scan
  before any public push).

## De-risk the live demo (the part that actually matters)
- **A cold-start test**: fresh clone/checkout → install → run → the demo path works, off the author's
  machine. This single check saves the most demos.
- **A rollback plan**: keep the last known-good deploy; if a late change breaks prod, revert in one step.
  Feature-flag anything risky so you can turn it off without a redeploy.
- **A recorded fallback**: once the flow works, capture a 60–90s screen recording. If live fails on
  stage, you still show the product.
- **Basic observability**: logs + an error alert on the deployed service, so a broken demo is diagnosable
  in seconds.

## What to SKIP (ponytail — these lose you time, not points)
Kubernetes, service meshes, multi-region, blue-green/canary, autoscaling, full IaC (Terraform) — none of
it is scored in 48 hours. A single small instance + a URL + a rollback + a recording is the right
amount. Add complexity only if the *task itself* is the infra.
