# Deploying to an Azure VM

One Bicep template (`main.bicep`) + one cloud-init file (`cloud-init.yaml`) stand up
a complete PatchPilot instance on a single Ubuntu VM — network, firewall, a static
public IP, and the VM itself, which provisions itself (Docker, clone, `.env`,
`docker compose up`) on first boot. No SSH required for setup or normal operation;
day-to-day commands go through `az vm run-command invoke` instead.

Run everything below from [Azure Cloud Shell](https://portal.azure.com) (the `>_`
icon, Bash) — it has `az`, `git`, and `openssl` pre-installed.

## Deploy

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fmkheagerty-lab%2FPatchPilot%2Fmain%2Finfra%2Fazure%2Fazuredeploy.json)

Click the button, sign in, and hit deploy — every field is already defaulted
(`location` is Australia East, a unique `dnsLabel` is generated for you,
there's no custom domain, SSH is off, and the VM size is
`Standard_B2as_v2`). All of these are plain editable fields in the form —
change the region, size, or anything else before clicking Create.
`sshPublicKey` defaults to a
placeholder value with no known private key, which is safe *only* because
SSH is off by default (no NSG rule opens port 22, so the placeholder can
never actually be used to log in) — see `enableSsh` below if you want real
SSH access. The deployment's `fqdn` / `url` outputs show the address the
instance is reachable at once cloud-init finishes (a few minutes after the
VM boots) — see "Verify" below.

### Manual / advanced: Azure CLI

Use the CLI instead of the button if you're deploying a fork
(`repoUrl`/`repoRef`), want SSH enabled at deploy time, or are scripting this
as part of your own CI/CD:

```bash
az group create -n patchpilot-rg -l australiaeast

ssh-keygen -t ed25519 -f ~/patchpilot_key -N ""

az deployment group create \
  -g patchpilot-rg \
  --template-file infra/azure/main.bicep \
  --parameters dnsLabel=patchpilot-mk \
               adminUsername=ppadmin \
               sshPublicKey="$(cat ~/patchpilot_key.pub)" \
               enableSsh=true \
               allowedSshSourceIp="$(curl -s ifconfig.me)/32"
```

- `dnsLabel` must be globally unique in the region — it becomes
  `<dnsLabel>.<region>.cloudapp.azure.com`, a free hostname Azure provides
  automatically (no domain registration needed). Omit it to use the
  template's own generated default instead.
- `customDomain` defaults to blank (the free hostname above); pass a domain
  you already own to use that instead. Either way it's stored as `PP_DOMAIN`
  and can be changed later (below) without redeploying.
- `enableSsh=true` opens the break-glass SSH rule, restricted to
  `allowedSshSourceIp`. Leave both out (or `enableSsh=false`) and the NSG
  never opens port 22 at all — SSH is never used by the deploy or verify flow
  itself. Always pass your own `sshPublicKey` when you set `enableSsh=true` —
  the template's default is a placeholder nobody holds the private key for,
  so leaving it in place with SSH enabled just locks you out, it doesn't
  grant anyone access.
- `repoUrl`/`repoRef` default to this repo's `main` branch; point them at
  your own fork/branch to deploy custom code.

After changing `infra/azure/main.bicep` or `cloud-init.yaml`, regenerate the
compiled artifact the "Deploy to Azure" button reads from:

```bash
az bicep build --file infra/azure/main.bicep --outfile infra/azure/azuredeploy.json
```

CI fails the build if this file is ever out of sync with its source.

## Verify (no SSH)

```bash
az vm run-command invoke -g patchpilot-rg -n patchpilot-vm \
  --command-id RunShellScript \
  --scripts "cd /opt/patchpilot && docker compose -f infra/docker-compose.yml ps"

az vm run-command invoke -g patchpilot-rg -n patchpilot-vm \
  --command-id RunShellScript \
  --scripts "cd /opt/patchpilot && docker compose -f infra/docker-compose.yml logs caddy --tail 50"
```

Then open the printed URL — expect the "Pair this instance" screen over valid
HTTPS. Complete setup via the onboarding pairing flow described in the main
[README](../../README.md).

## Switch to a custom domain later

```bash
az vm run-command invoke -g patchpilot-rg -n patchpilot-vm \
  --command-id RunShellScript \
  --scripts "cd /opt/patchpilot && sed -i 's#PP_DOMAIN=.*#PP_DOMAIN=patchpilot.yourdomain.com#; s#PUBLIC_URL=.*#PUBLIC_URL=https://patchpilot.yourdomain.com#; s#AUTH_REDIRECT_URI=.*#AUTH_REDIRECT_URI=https://patchpilot.yourdomain.com/auth/callback#; s#CORS_ORIGINS=.*#CORS_ORIGINS=https://patchpilot.yourdomain.com#' .env && docker compose -f infra/docker-compose.yml up -d"
```

Point the domain's A record at the deployment's static IP first
(`az network public-ip show -g patchpilot-rg -n patchpilot-ip --query ipAddress -o tsv`),
and update the Entra app registration's redirect URI to match. Caddy issues a
fresh Let's Encrypt certificate for the new domain automatically.

## Update to the latest code

```bash
az vm run-command invoke -g patchpilot-rg -n patchpilot-vm \
  --command-id RunShellScript \
  --scripts "cd /opt/patchpilot && git pull && docker compose -f infra/docker-compose.yml up -d --build"
```

## Backups

The `backup` container dumps Postgres nightly to `/opt/patchpilot/backups` on
the VM's own disk only — `infra/backup.sh` is local-disk-only by design (see
its header comment). Arrange your own off-box copy (e.g. a scheduled
`az storage blob upload-batch` via `run-command`) — a VM-local backup does not
survive losing the VM.
