# Deploying to an Azure VM

One Bicep template (`main.bicep`) + one cloud-init file (`cloud-init.yaml`) stand up
a complete PatchPilot instance on a single Ubuntu VM — network, firewall, a static
public IP, and the VM itself, which provisions itself (Docker, clone, `.env`,
`docker compose up`) on first boot. No SSH required for setup or normal operation;
day-to-day commands go through `az vm run-command invoke` instead.

Run everything below from [Azure Cloud Shell](https://portal.azure.com) (the `>_`
icon, Bash) — it has `az`, `git`, and `openssl` pre-installed.

## Deploy

```bash
az group create -n patchpilot-rg -l australiaeast

ssh-keygen -t ed25519 -f ~/patchpilot_key -N ""

az deployment group create \
  -g patchpilot-rg \
  --template-file infra/azure/main.bicep \
  --parameters dnsLabel=patchpilot-mk \
               adminUsername=azureuser \
               sshPublicKey="$(cat ~/patchpilot_key.pub)" \
               allowedSshSourceIp="$(curl -s ifconfig.me)/32"
```

- `dnsLabel` must be globally unique in the region — it becomes
  `<dnsLabel>.<region>.cloudapp.azure.com`, a free hostname Azure provides
  automatically (no domain registration needed).
- The command omits `customDomain` on purpose, which makes `az` prompt for it
  interactively — press Enter to skip it (uses the free hostname above) or type
  a domain you already own. Either way it's stored as `PP_DOMAIN` and can be
  changed later (below) without redeploying.
- `allowedSshSourceIp` restricts the break-glass SSH rule to your current IP.
  SSH is never used by the deploy or verify flow itself.

The deployment's `fqdn` / `url` outputs show the address the instance is
reachable at once cloud-init finishes (a few minutes after the VM boots).

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
