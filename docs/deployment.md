# Production deployment

Gridlock is deployed from
[`RayTsai13/gridlock-landuse-sim`](https://github.com/RayTsai13/gridlock-landuse-sim)
to a DigitalOcean droplet. GitHub Actions runs the test suite and then connects
to the droplet over SSH to rebuild and restart the Docker Compose application.

## Current production target

| Setting | Value |
| --- | --- |
| DigitalOcean droplet | `gridlock-prod` |
| Region | `sfo2` |
| Operating system | Ubuntu 24.04 |
| SSH/deployment user | `deploy` |
| Server checkout | `/home/deploy/Gridlock` |
| Git branch | `main` |
| Public service | HTTP on port 80 |
| Health check | `GET /healthz` |

The former `DUBHACKS26` droplet has been deleted. Deployment from the old
`RayTsai13/Gridlock` repository is disabled. Do not restore that workflow as a
second production deployment path.

The production app is currently addressed by the droplet's IPv4 address. The
address is deliberately not recorded here; DigitalOcean and the
`DROPLET_HOST` Actions secret are the sources of truth.

## Deployment flow

`.github/workflows/deploy.yml` runs on every push to `main` and can also be
started manually. It:

1. Calls `.github/workflows/ci.yml` and waits for the backend and frontend jobs
   to pass.
2. Opens an SSH session as `deploy` using `appleboy/ssh-action`.
3. Updates `/home/deploy/Gridlock` to `origin/main`.
4. Runs `docker compose up -d --build`.
5. Prunes dangling Docker images.

The server checkout is deployment state, not a development workspace. Do not
make uncommitted edits there: the workflow uses `git reset --hard origin/main`.

Compose builds the frontend and backend images directly on the droplet. The
`yourdockerhubuser/...` names in `docker-compose.yml` are local image tags; no
Docker Hub login or image pull is required.

## GitHub Actions secrets

The production repository must define these repository-level Actions secrets:

| Secret | Contents |
| --- | --- |
| `DROPLET_HOST` | Current public IPv4 address of `gridlock-prod` |
| `DROPLET_USER` | `deploy` |
| `DROPLET_SSH_KEY` | Private half of the dedicated deployment key |

The matching public key is installed in
`/home/deploy/.ssh/authorized_keys`. Never commit or paste the private key into
an issue, log, or documentation file.

Check that the secret names exist without exposing their values:

```bash
gh secret list --repo RayTsai13/gridlock-landuse-sim
```

## Deploy and verify

Start a deployment from a local checkout:

```bash
gh workflow run deploy.yml \
  --repo RayTsai13/gridlock-landuse-sim \
  --ref main

gh run watch \
  --repo RayTsai13/gridlock-landuse-sim \
  --exit-status
```

After a successful run, verify the public endpoint, substituting the current
droplet address:

```bash
curl -fsS http://DROPLET_IP/healthz
curl -I http://DROPLET_IP/
```

The health endpoint should return JSON with `"status":"ok"`, and the root
request should return `HTTP/1.1 200 OK`.

## Server access and diagnostics

The dedicated deployment key is normally stored at
`~/.ssh/gridlock_actions` on the maintainer's machine. With an authenticated
`doctl` installation, connect with:

```bash
doctl compute ssh gridlock-prod \
  --ssh-user deploy \
  --ssh-key-path ~/.ssh/gridlock_actions
```

Compose commands must run from the checkout directory:

```bash
cd ~/Gridlock
docker compose ps
curl -fsS http://127.0.0.1/healthz
curl -I http://127.0.0.1/
```

Inspect recent service logs with:

```bash
cd ~/Gridlock
docker compose logs --tail=100 backend
docker compose logs --tail=100 frontend
docker compose logs --tail=100 caddy
```

For a manual redeploy, use the same sequence as the workflow:

```bash
cd ~/Gridlock
git fetch origin main
git reset --hard origin/main
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1/healthz
```

## Droplet baseline

The current one-gigabyte droplet is configured with:

- Docker Engine and the Docker Compose plugin from Docker's Ubuntu repository.
- A two-gigabyte swap file at `/swapfile`, persisted in `/etc/fstab`, with
  `vm.swappiness=10`.
- UFW enabled with inbound TCP ports 22, 80, and 443 allowed.
- The `deploy` user in the `docker` group.

Membership in the `docker` group effectively grants root-level control of the
host. Treat the deployment private key as a production credential and rotate
it immediately if it may have been exposed.

The application itself has no database or persistent user-data volume. Caddy's
named volumes hold proxy state, but the current IP-address/HTTP configuration
does not contain irreplaceable application data.

## Current limitations

- `ci.yml` runs independently on pushes to `main`, while `deploy.yml` calls it
  again, so a main-branch push currently runs CI twice.
- Deployments reset to the current `origin/main` tip rather than an immutable
  commit SHA and have no concurrency guard.
- The workflow does not wait for Compose health checks or call `/healthz`
  after restarting the services.
- `Caddyfile` listens on `:80`. Port 443 is published, but HTTPS will not be
  enabled until a domain points to the droplet and the Caddy site address is
  changed to that domain.

These limitations do not prevent deployment, but they should be addressed
before relying on the service for production traffic.
