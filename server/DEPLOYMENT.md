# Capsio collaboration service deployment

The service is small: PostgreSQL stores accounts, membership and the current
state of every synced file and record; Alibaba OSS stores file contents; one
Node process handles sign-in, sync and the optional model gateway. Desktop
clients upload and download files straight to OSS through short-lived signed
URLs, so file bytes never pass through this server.

**Production (since 2026-11-25)** is `https://capsio.cloud`
(Ubuntu 24.04, PostgreSQL 16, Nginx
1.24, a host shared with another site). The website, this API (`/v1/`, `/admin`) and the
forum (`/discuss/`) share the domain: `deploy/nginx/capsio-cloud.conf`. Update
the service with `bash server/deploy/update.sh`, which deploys a pushed commit
from GitHub and rolls back if it is unhealthy; `capsio-backup.timer` dumps the
databases to `/var/backups/capsio` every day. Before that it ran on Tencent
Cloud at `https://124.221.115.83:8443`, which now forwards to capsio.cloud for
builds that still use it.

The steps below were run on Ubuntu 26.04 (Node 22, PostgreSQL 18, Nginx 1.28).
Everything comes from the distribution archive except the application itself
and its Node.

## 0. Before you start

- **Reachability from mainland China.** Check that users can reach the host
  before deploying. An overseas IP can be blocked for TCP while ping still
  works: test TCP to port 22 from mainland probes (for example the Globalping
  API) and from the host to `dypnsapi.aliyuncs.com:443`, which SMS sign-in
  needs. Replace the IP if either fails.
- **Firewall.** The cloud firewall or security group must allow TCP 80 (for
  certificate validation) and 443, or 8443 on a shared host (section 5).
- **OSS bucket and key.** Create a private bucket and a RAM user whose key can
  only use it. The key needs at least this policy:

  ```json
  {
    "Version": "1",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": ["oss:PutObject", "oss:GetObject", "oss:DeleteObject"],
        "Resource": ["acs:oss:*:*:<bucket>/*"]
      }
    ]
  }
  ```

  Without it OSS answers `AccessDenied ... ImplicitDeny`. The service signs
  URLs with signature V4, which new accounts and new buckets require.
- **SMS.** Production uses Alibaba Cloud Phone Number Verification Service
  (PNVS, `dypnsapi.aliyuncs.com`): it makes the code, texts it with a system
  signature and template (login template `100001`) and checks it. The RAM key
  needs `SendSmsVerifyCode` and `CheckSmsVerifyCode`. The older choice,
  `SMS_SERVICE=sms`, texts codes the server makes through Short Message Service
  (`dysmsapi.aliyuncs.com`) and needs an approved signature and template there.

## 1. Packages, account and folders

```bash
sudo apt-get install -y postgresql nginx nodejs acme.sh
sudo useradd --system --home-dir /opt/capsio-collab --shell /usr/sbin/nologin capsio
sudo mkdir -p /opt/capsio-collab/server /var/www/acme
```

Node 20 or newer is recommended. Ubuntu 24.04 ships Node 18, which runs the
service; on a shared host keep the system Node that other services use.
certbot 4.0 cannot issue IP-address certificates; acme.sh 3.1 can. Ubuntu
24.04 does not package acme.sh, and a shared host already has a certificate.

## 2. Database

Use a dedicated role and database; never share another service's database.

```bash
pw=$(openssl rand -hex 24)
sudo -u postgres psql -c "CREATE ROLE capsio_app LOGIN PASSWORD '$pw'"
sudo -u postgres createdb -O capsio_app capsio
```

The service creates and upgrades its tables on start.

## 3. Environment

Write `/etc/capsio-collab.env`, mode 600, owned by `capsio`. Start
from `.env.example`. Required:

- `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=8081`, `TRUST_PROXY=true`
- `DATABASE_URL=postgresql://capsio_app:<pw>@127.0.0.1:5432/capsio`
- `JWT_SECRET`, from `openssl rand -hex 32`
- `OSS_BUCKET`, `OSS_REGION` (for example `cn-hangzhou`), `OSS_ENDPOINT`
  (`https://oss-cn-hangzhou.aliyuncs.com`), `OSS_ACCESS_KEY_ID`,
  `OSS_ACCESS_KEY_SECRET`
- `SMS_SERVICE` (`pnvs` or `sms`, default `sms`), `SMS_ACCESS_KEY_ID`,
  `SMS_ACCESS_KEY_SECRET`, `SMS_SIGN_NAME`, `SMS_TEMPLATE_CODE`. Codes have six
  digits and last five minutes; the server still allows one a minute per
  number and five tries per code, and a code works once.

For test accounts set `DEV_SMS_CODE` together with `DEV_SMS_PHONES` (a
comma-separated list). Those numbers sign in with the fixed code and receive
no SMS. Production refuses to start with a fixed code but no list, because
the code would otherwise sign anyone in.

Secrets live only in this file. Desktop builds need nothing but the public
service address.

## 4. Application and service

Push the commit, then from a machine that can log in to the host with a key:

```bash
bash server/deploy/update.sh [ssh-host] [commit]   # default: your-host, origin/main
```

`deploy/update-remote.sh` runs on the host as root. It installs Node 22 in
`/opt/capsio-collab/node` when missing, checks out `server/` at the commit,
installs the dependency from the lockfile, backs up the running code and the
database to `/root/backups/capsio-collab-<time>`, swaps the new code into
`/opt/capsio-collab/server` (owned by root; the service account only reads
it), installs `capsio-collab.service` and the backup timer, restarts and
checks `/v1/health`, putting the previous version back if it fails. The
first run installs everything; later runs update.

## 5. Nginx and HTTPS

Install the three files under `deploy/nginx/`:

| File | Destination |
| --- | --- |
| `capsio-limits.conf` | `/etc/nginx/conf.d/`: per-address limits (sign-in codes 6/min, API 30/s) |
| `capsio-proxy.conf` | `/etc/nginx/snippets/`: proxy headers, including `X-Real-IP` |
| `capsio-site.conf` | `/etc/nginx/sites-available/capsio`, linked into `sites-enabled` |

The site serves `/.well-known/acme-challenge/` from `/var/www/acme` on port
80 and the API on 443 with a 16 MiB body limit; Nginx's default 1 MiB would
reject larger sync pushes.

On a host where another site already serves port 443 for the address, leave
its server blocks alone. Install `capsio-8443.conf` as
`/etc/nginx/conf.d/capsio.conf` instead of the site file, with its
certificate lines pointing at that site's certificate for the address. The
API then listens on 8443; the other site's renewals reload Nginx, so this
server picks up the new certificate as well. The cloud firewall must allow TCP
8443. Mainland hosts cannot use a domain without an ICP filing, so the bare
IP on its own port is the simplest address there. Skip the certificate steps
below.

Issue the certificate while only the port-80 block is active, then enable
the 443 block:

```bash
sudo acme.sh --issue --server letsencrypt -d <ip-or-domain> -w /var/www/acme \
  --cert-profile shortlived --days 3          # IP certificates: shortlived profile
sudo mkdir -p /etc/nginx/tls && sudo chmod 700 /etc/nginx/tls
sudo acme.sh --install-cert -d <ip-or-domain> --ecc \
  --key-file /etc/nginx/tls/capsio.key --fullchain-file /etc/nginx/tls/capsio.crt \
  --reloadcmd "systemctl reload nginx"
```

For a domain, drop `--cert-profile shortlived --days 3`. Let's Encrypt IP
certificates last 160 hours, so renewal must be automatic and must not run
more often than needed; the duplicate-certificate limit is five a week.
Install the timer, which checks twice a day and renews only when due:

```bash
sudo install -m 644 deploy/acme-renew.service deploy/acme-renew.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now acme-renew.timer
```

## 6. Smoke checks

1. `curl https://<host>/v1/health` (`https://<host>:8443/v1/health` on a
   shared host) from outside the host reports `database: ok`.
2. A test number signs in with `DEV_SMS_CODE`; a real number receives an SMS.
3. Two desktop clients on the same account open one cloud project; a note,
   a PDF and a code file edited on one device appear on the other.

Point desktop builds at the service with `CAPSIO_COLLAB_ENDPOINT` at build
time, or change the address under Settings → Collaboration.

## 7. Admin pages and official models

The admin pages ship in `admin/` next to `src/`, and `deploy/update.sh`
uploads both. Nginx must pass `/admin` to the service: the two `/admin`
locations in `capsio-8443.conf` and `capsio-site.conf`. Then grant the
first administrator from the host; the account must already exist. The tool
runs with the service's own environment file, read by systemd as the service
reads it:

```bash
sudo systemd-run --quiet --wait --pipe --uid=capsio --gid=capsio \
  -p EnvironmentFile=/etc/capsio-collab.env \
  -p WorkingDirectory=/opt/capsio-collab/server \
  /usr/bin/node src/admin-cli.mjs grant 13800000000 owner
```

Sign in at `https://<host>:8443/admin/` with the phone and the password. An
account without a password, or with a forgotten one, uses 忘记密码 on the
sign-in page: an SMS code (sent only to administrators) sets a new password,
which also signs the desktop app out.

Before any model is offered, add a channel (the upstream address and key).
选择模型 on the channel reads the upstream's `/models` list and adds the
picked models unlisted; in 新增模型 the upstream field offers the same list
and fills the ID and name. Then give each model its cost and price per million
tokens and the plans it is open to, and list it. A model without a price cannot
be listed. The
gateway refuses requests with `402 quota_exhausted`, `403 model_not_in_plan`,
`429 rate_limited` or `daily_limit`, and `403 account_disabled`; the desktop
app turns these codes into explanations.
