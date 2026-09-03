<#
.SYNOPSIS
    Deploy-PatchPilot.ps1 - Idempotent installer for the PatchPilot Entra ID app registration.

.DESCRIPTION
    Creates or reuses a multi-tenant Entra ID app registration for PatchPilot,
    configures API permissions, exposes an access_as_user API scope, creates or reuses
    a local service principal, enumerates active GDAP relationships, generates customer
    admin consent URLs, and optionally writes a .env file.

.NOTES
    Recommended: PowerShell 7+
    Auth mode: normal interactive Microsoft Graph sign-in.

.EXAMPLE
    .\Deploy-PatchPilot.ps1 -MspTenantId "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" -RedirectUri "http://localhost:5173/auth/callback"

.EXAMPLE
    # -MspTenantId can be omitted entirely from a session already signed in
    # to Azure (Connect-AzAccount or az login) - it's auto-detected from that
    # session. This is the normal case in Azure Cloud Shell.
    .\Deploy-PatchPilot.ps1

.EXAMPLE
    .\Deploy-PatchPilot.ps1 -MspTenantId "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" -RotateClientSecret

.EXAMPLE
    .\Deploy-PatchPilot.ps1 -MspTenantId "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" -Uninstall

.EXAMPLE
    # Opt in to the Phase 5 remediation WRITE scopes (Live Response + Intune
    # device management + Windows Update). Omit the switch for a read-only install.
    .\Deploy-PatchPilot.ps1 -MspTenantId "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" -EnableRemediationWriteScopes
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # Not actually mandatory at the parameter level: if omitted, the
    # auto-detection block right after $ErrorActionPreference below tries to
    # fill it in from an already-authenticated Azure session (Get-AzContext,
    # then `az account show`) before falling back to a hard error. This is
    # aimed at the Azure Cloud Shell one-liner (see
    # apps/web/src/pages/setup/SetupPairing.tsx) - Cloud Shell is always
    # already signed in to Azure as the admin running it, so there's nothing
    # left for them to type. Still explicitly overridable, e.g. to target a
    # tenant other than the one the current session happens to be signed
    # into.
    [Parameter(Mandatory = $false)]
    [string] $MspTenantId,

    # The {{...}} default below is a template placeholder, substituted with
    # this instance's real AUTH_REDIRECT_URI on a personalized download (see
    # apps/api/src/routes/onboarding-pairing.ts), same mechanism as
    # $InstanceUrl/$PairingToken below. Deliberately written as "{{...}}"
    # here rather than spelling out the literal token: the server's
    # substitution is a global find-and-replace across this whole file, so
    # writing the exact token in a comment or comparison gets it silently
    # rewritten too, same as the param default. An un-substituted placeholder
    # means this is a plain, unmodified copy of the script (a self-hosted git
    # clone) - the fallback right after $ErrorActionPreference below restores
    # this parameter's original localhost default in that case.
    [Parameter(Mandatory = $false)]
    [string] $RedirectUri = "{{REDIRECT_URI}}",

    # $env:USERPROFILE is Windows-only and empty on Cloud Shell's Linux pwsh,
    # which silently collapsed this to the OS root ("/PatchPilot-Deploy") -
    # not writable, so every run there failed at the very first step. $HOME
    # is set on both: Windows PowerShell 5.1 sets it to $env:USERPROFILE
    # directly, and PowerShell 7+ (incl. Cloud Shell) sets it to the real
    # cross-platform home directory. Join-Path also picks the right
    # separator for whichever OS this runs on, instead of a hardcoded "\".
    [Parameter(Mandatory = $false)]
    [string] $OutputFolder = (Join-Path $HOME "PatchPilot-Deploy"),

    [Parameter(Mandatory = $false)]
    [switch] $RotateClientSecret,

    # Read-only-first: by default the app registration requests ONLY read scopes,
    # so a fresh install can never issue a Microsoft write. Pass this switch to also
    # request the Phase 5 remediation write scopes (see $remediationWriteScopes
    # below). PatchPilot still gates every write behind the per-tenant `readOnly`
    # flag at execution time - granting the scope does not by itself enable writes.
    [Parameter(Mandatory = $false)]
    [switch] $EnableRemediationWriteScopes,

    [Parameter(Mandatory = $false)]
    [switch] $Uninstall,

    # Phone-home pairing (hosted SaaS instances only — see
    # apps/api/src/routes/onboarding-pairing.ts). When both resolve to real
    # values, this script POSTs the resulting app registration's
    # ClientId/TenantId/ClientSecret directly to $InstanceUrl, authenticated
    # solely by the single-use $PairingToken, instead of (or alongside)
    # writing a local .env file.
    #
    # The {{...}} defaults below are template placeholders: a personalized
    # download from the instance's Setup page substitutes them with the real
    # instance URL and a freshly minted token, so the Global Admin only has to
    # run `.\Deploy-PatchPilot.ps1 -MspTenantId <theirs>`. This checked-in copy
    # of the script keeps the placeholders un-substituted, which the pairing
    # step below (§14) treats as "not supplied" — a self-hoster running this
    # file directly from a git clone is completely unaffected.
    [Parameter(Mandatory = $false)]
    [string] $InstanceUrl = "{{INSTANCE_URL}}",

    [Parameter(Mandatory = $false)]
    [string] $PairingToken = "{{PAIRING_TOKEN}}"
)

$ErrorActionPreference = "Stop"

# See the $RedirectUri param comment above: an un-substituted "{{...}}"
# placeholder means this is an unmodified copy of the script, not a
# personalized download - restore the real default so a self-hoster's
# experience is unchanged. Checked via StartsWith/EndsWith, not an exact
# literal match against the placeholder text itself - the server's
# substitution is a global replace across the whole file, so spelling out
# that exact placeholder text again here (rather than describing it as
# "{{...}}") would get it rewritten right along with the param default
# above, and this check would then compare the substituted real value
# against itself and always be true.
if ($RedirectUri.StartsWith("{{") -and $RedirectUri.EndsWith("}}")) {
    $RedirectUri = "http://localhost:5173/auth/callback"
}

# See the $MspTenantId param comment above. Tries Get-AzContext first since
# Azure Cloud Shell's PowerShell flavor always has the Az module pre-loaded
# and pre-authenticated with zero setup; `az account show` is the fallback
# for anywhere else a plain `az login` already happened (including Cloud
# Shell's bash flavor, if this were ever invoked through it). Neither is a
# new hard dependency for the script as a whole - both checks are skipped
# entirely, with no error, when $MspTenantId is already supplied.
if (-not $MspTenantId) {
    $detectedTenantId = $null
    $detectionSource = $null

    if (Get-Command Get-AzContext -ErrorAction SilentlyContinue) {
        try {
            $azContext = Get-AzContext -ErrorAction Stop
            if ($azContext -and $azContext.Tenant -and $azContext.Tenant.Id) {
                $detectedTenantId = $azContext.Tenant.Id
                $detectionSource = "the active Az PowerShell session"
            }
        }
        catch {
            # No active Az session - fall through to the Azure CLI check below.
        }
    }

    if (-not $detectedTenantId -and (Get-Command az -ErrorAction SilentlyContinue)) {
        try {
            $cliTenantId = (az account show --query tenantId -o tsv 2>$null)
            if ($cliTenantId -and $cliTenantId -match '^[0-9a-fA-F-]{36}$') {
                $detectedTenantId = $cliTenantId
                $detectionSource = "the active Azure CLI session"
            }
        }
        catch {
            # `az` is present but not signed in - fall through to the error below.
        }
    }

    if ($detectedTenantId) {
        $MspTenantId = $detectedTenantId
        Write-Host "No -MspTenantId supplied - using $MspTenantId, detected from $detectionSource." -ForegroundColor DarkGray
    }
    else {
        throw "MspTenantId is required. Pass -MspTenantId <your-tenant-id>, or run this from a session already signed in to Azure (Connect-AzAccount or az login) - e.g. Azure Cloud Shell."
    }
}

$AppDisplayName = "PatchPilot"

# ------------------------------------------------------------
# Helper functions
# ------------------------------------------------------------

function Write-Step {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Message
    )

    Write-Host ""
    Write-Host $Message -ForegroundColor Cyan
}

function Write-Info {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Message
    )

    Write-Host "    $Message" -ForegroundColor DarkGray
}

function Write-Success {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Message
    )

    Write-Host "    $Message" -ForegroundColor Green
}

function Write-WarningMessage {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Message
    )

    Write-Host "    [!] $Message" -ForegroundColor Yellow
}

function Ensure-Folder {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    if (-not (Test-Path -Path $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function New-Base64Key {
    $bytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes)
}

function Ensure-MicrosoftGraphModules {
    Write-Step "[1/14] Checking Microsoft Graph PowerShell modules..."

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    }
    catch {
        Write-WarningMessage "Could not force TLS 1.2. Continuing."
    }

    $requiredModules = @(
        "Microsoft.Graph.Authentication",
        "Microsoft.Graph.Applications",
        "Microsoft.Graph.Identity.DirectoryManagement",
        "Microsoft.Graph.Identity.Partner"
    )

    if (-not (Get-Module -ListAvailable -Name "Microsoft.Graph")) {
        Write-WarningMessage "Microsoft.Graph module not found. Installing for CurrentUser..."

        try {
            if (-not (Get-PackageProvider -Name NuGet -ErrorAction SilentlyContinue)) {
                Write-Info "Installing NuGet package provider..."
                Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force | Out-Null
            }

            try {
                Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction Stop
            }
            catch {
                Write-WarningMessage "Could not set PSGallery as trusted. Install-Module may prompt."
            }

            Install-Module Microsoft.Graph -Scope CurrentUser -Force -AllowClobber
        }
        catch {
            throw "Failed to install Microsoft.Graph module. Error: $($_.Exception.Message)"
        }
    }
    else {
        Write-Success "Microsoft.Graph module already installed."
    }

    foreach ($moduleName in $requiredModules) {
        Write-Info "Importing Graph module: $moduleName"
        Import-Module $moduleName -ErrorAction Stop
    }

    Write-Success "Graph modules loaded."
}

function Resolve-ResourceAccess {
    param(
        [Parameter(Mandatory = $true)]
        [string] $ResourceName,

        [Parameter(Mandatory = $true)]
        [string] $ResourceAppId,

        [Parameter(Mandatory = $true)]
        [string[]] $ScopeValues
    )

    Write-Info "Resolving service principal for $ResourceName..."

    $sp = @(Get-MgServicePrincipal -Filter "appId eq '$ResourceAppId'" -ErrorAction SilentlyContinue)

    if (-not $sp -or $sp.Count -eq 0) {
        Write-WarningMessage "$ResourceName service principal not found. Skipping this permission set."
        return $null
    }

    $resourceSp = $sp[0]

    $access = foreach ($value in $ScopeValues) {
        $scope = $resourceSp.Oauth2PermissionScopes | Where-Object { $_.Value -eq $value } | Select-Object -First 1

        if (-not $scope) {
            Write-WarningMessage "$ResourceName missing delegated scope: $value"
            continue
        }

        @{
            Id   = $scope.Id
            Type = "Scope"
        }
    }

    $access = @($access)

    if ($access.Count -eq 0) {
        Write-WarningMessage "$ResourceName had no matching scopes. Skipping this permission set."
        return $null
    }

    Write-Success "$ResourceName resolved $($access.Count) delegated scope(s)."

    return @{
        ResourceAppId  = $ResourceAppId
        ResourceAccess = $access
    }
}

function Set-DelegatedAdminConsent {
    <#
        Grants (or refreshes) tenant-wide admin consent for a set of delegated
        scopes from PatchPilot's service principal to one resource (Graph /
        Defender / Partner Center). This is the programmatic equivalent of an admin
        clicking the /adminconsent URL: it writes an AllPrincipals
        oauth2PermissionGrant so the home-tenant OBO token actually carries the
        scopes. Idempotent - on a re-run it unions in any newly-added scopes and is
        a no-op when nothing changed. Returns $true on success, $false if consent
        could not be written (caller falls back to the printed admin-consent URL).
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string] $ClientSpId,

        [Parameter(Mandatory = $true)]
        [string] $ResourceName,

        [Parameter(Mandatory = $true)]
        [string] $ResourceAppId,

        [Parameter(Mandatory = $true)]
        [string[]] $ScopeValues
    )

    $resourceSp = @(Get-MgServicePrincipal -Filter "appId eq '$ResourceAppId'" -ErrorAction SilentlyContinue)[0]
    if (-not $resourceSp) {
        Write-WarningMessage "$ResourceName service principal not found - cannot grant consent."
        return $false
    }

    # Only consent scopes the resource actually publishes, so we never write an invalid grant.
    $publishable = @($resourceSp.Oauth2PermissionScopes | ForEach-Object { $_.Value })
    $valid = @($ScopeValues | Where-Object { $publishable -contains $_ })
    if ($valid.Count -eq 0) {
        Write-WarningMessage "$ResourceName published none of the requested scopes - nothing to consent."
        return $false
    }

    try {
        $existing = @(
            Get-MgOauth2PermissionGrant -All -Filter "clientId eq '$ClientSpId' and consentType eq 'AllPrincipals'" -ErrorAction Stop
        ) | Where-Object { $_.ResourceId -eq $resourceSp.Id } | Select-Object -First 1

        if ($existing) {
            $current = @()
            if ($existing.Scope) { $current = @($existing.Scope -split '\s+' | Where-Object { $_ }) }
            $missing = @($valid | Where-Object { $current -notcontains $_ })

            if ($missing.Count -eq 0) {
                Write-Success "$ResourceName already admin-consented ($($current.Count) scope(s))."
                return $true
            }

            $merged = @($current + $valid | Select-Object -Unique)
            Update-MgOauth2PermissionGrant -OAuth2PermissionGrantId $existing.Id -Scope ($merged -join ' ') -ErrorAction Stop
            Write-Success "$ResourceName consent refreshed (+$($missing.Count) scope(s): $($missing -join ', '))."
        }
        else {
            New-MgOauth2PermissionGrant -BodyParameter @{
                clientId    = $ClientSpId
                consentType = "AllPrincipals"
                resourceId  = $resourceSp.Id
                scope       = ($valid -join ' ')
            } -ErrorAction Stop | Out-Null
            Write-Success "$ResourceName admin consent granted ($($valid.Count) scope(s))."
        }
        return $true
    }
    catch {
        Write-WarningMessage "$ResourceName consent could not be written: $($_.Exception.Message)"
        return $false
    }
}

function Test-RedirectUriExists {
    param(
        [Parameter(Mandatory = $false)]
        $Application,

        [Parameter(Mandatory = $true)]
        [string] $Uri,

        [Parameter(Mandatory = $true)]
        [ValidateSet("Web", "Spa")]
        [string] $Platform
    )

    if (-not $Application) {
        return $false
    }

    if ($Platform -eq "Web") {
        if (-not $Application.Web -or -not $Application.Web.RedirectUris) {
            return $false
        }

        return ($Application.Web.RedirectUris -contains $Uri)
    }

    if ($Platform -eq "Spa") {
        if (-not $Application.Spa -or -not $Application.Spa.RedirectUris) {
            return $false
        }

        return ($Application.Spa.RedirectUris -contains $Uri)
    }
}

function Merge-RedirectUris {
    param(
        [Parameter(Mandatory = $false)]
        [string[]] $ExistingUris,

        [Parameter(Mandatory = $true)]
        [string] $NewUri
    )

    $merged = @()

    if ($ExistingUris) {
        $merged += $ExistingUris
    }

    if ($merged -notcontains $NewUri) {
        $merged += $NewUri
    }

    return @($merged | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
}

# ------------------------------------------------------------
# Main script
# ------------------------------------------------------------

$transcriptStarted = $false
$transcriptPath = $null
$csvPath = $null
$envPath = $null
$secret = $null

try {
    Ensure-Folder -Path $OutputFolder

    $transcriptPath = Join-Path $OutputFolder ("deploy-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))

    try {
        Start-Transcript -Path $transcriptPath -Append | Out-Null
        $transcriptStarted = $true
    }
    catch {
        Write-Warning "Could not start transcript. Continuing without transcript. Error: $($_.Exception.Message)"
    }

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host " PatchPilot Deployment Script"           -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""

    Ensure-MicrosoftGraphModules

    # ------------------------------------------------------------
    # Connect to Microsoft Graph
    # ------------------------------------------------------------

    Write-Step "[2/14] Connecting to Microsoft Graph..."

    Write-Info "Using normal interactive sign-in."
    Write-Info "Tenant: $MspTenantId"

    Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null

    # Application.ReadWrite.All creates/updates the app registration and its service
    # principal; DelegatedAdminRelationship.Read.All enumerates GDAP customers for the
    # consent-URL list; DelegatedPermissionGrant.ReadWrite.All lets step [9/13] grant
    # the home-tenant admin consent programmatically (create/refresh the AllPrincipals
    # oauth2PermissionGrants) so a re-run after adding a scope re-consents automatically
    # instead of relying on a human clicking a URL. All three are consented interactively
    # by the admin running this script - they are NOT standing app permissions, so the
    # running PatchPilot app stays read-only-first (invariant #6). The old app-only/
    # security-group path (AppRoleAssignment.ReadWrite.All + GroupMember.ReadWrite.All)
    # is gone: GDAP only supports delegated ("app + user") access.
    Connect-MgGraph `
        -TenantId $MspTenantId `
        -Scopes @(
            "Application.ReadWrite.All",
            "DelegatedAdminRelationship.Read.All",
            "DelegatedPermissionGrant.ReadWrite.All"
        ) `
        -NoWelcome | Out-Null

    $context = Get-MgContext

    if (-not $context) {
        throw "Microsoft Graph connection failed. No Graph context returned."
    }

    Write-Success "Connected to Microsoft Graph as $($context.Account)."

    # ------------------------------------------------------------
    # Uninstall path
    # ------------------------------------------------------------

    if ($Uninstall) {
        Write-Step "[Uninstall] Removing existing PatchPilot app registration..."

        $existingApps = @(Get-MgApplication -Filter "displayName eq '$AppDisplayName'" -ErrorAction SilentlyContinue)

        if ($existingApps.Count -eq 0) {
            Write-WarningMessage "No existing PatchPilot app registration found."
        }

        foreach ($existingApp in $existingApps) {
            if ($PSCmdlet.ShouldProcess($existingApp.DisplayName, "Remove app registration and service principal")) {
                Write-Info "Checking service principal for AppId $($existingApp.AppId)..."

                $existingSps = @(Get-MgServicePrincipal -Filter "appId eq '$($existingApp.AppId)'" -ErrorAction SilentlyContinue)

                foreach ($existingSp in $existingSps) {
                    try {
                        Remove-MgServicePrincipal -ServicePrincipalId $existingSp.Id -ErrorAction Stop
                        Write-Success "Removed service principal: $($existingSp.Id)"
                    }
                    catch {
                        Write-WarningMessage "Could not remove service principal $($existingSp.Id): $($_.Exception.Message)"
                    }
                }

                Remove-MgApplication -ApplicationId $existingApp.Id -ErrorAction Stop
                Write-Success "Removed app registration: $($existingApp.AppId)"
            }
        }

        return
    }

    # ------------------------------------------------------------
    # 1. Create or reuse app registration
    # ------------------------------------------------------------

    Write-Step "[3/14] Creating or reusing Entra ID app registration..."

    $existingApps = @(Get-MgApplication -Filter "displayName eq '$AppDisplayName'" -ErrorAction SilentlyContinue)

    if ($existingApps.Count -gt 0) {
        $app = $existingApps[0]
        Write-WarningMessage "App already exists. Reusing AppId: $($app.AppId)"
    }
    else {
        $appParams = @{
            DisplayName    = $AppDisplayName
            SignInAudience = "AzureADMultipleOrgs"
            Description    = "Multi-tenant MSP patch management console for Microsoft 365, Defender, and Intune."
            Tags           = @(
                "PatchPilot",
                "MSP",
                "GDAP",
                "PatchManagement"
            )
            # Confidential client: the redirect URI lives on the Web platform ONLY.
            # Registering it on the SPA platform makes Entra treat it as cross-origin
            # and enforce PKCE (AADSTS9002325), which is incompatible with the
            # server-side code exchange + client secret PatchPilot uses.
            Web            = @{
                RedirectUris          = @($RedirectUri)
                ImplicitGrantSettings = @{
                    EnableIdTokenIssuance = $true
                }
            }
        }

        if ($PSCmdlet.ShouldProcess($AppDisplayName, "Create app registration")) {
            $app = New-MgApplication @appParams
            Write-Success "Created app registration. AppId: $($app.AppId)"
        }
    }

    if (-not $app) {
        throw "App registration was not created or retrieved."
    }

    # ------------------------------------------------------------
    # 2. Configure API permissions
    # ------------------------------------------------------------

    Write-Step "[4/14] Configuring API permissions..."

    # Delegated scopes back BOTH tenant paths. Login and the home-tenant OBO read are
    # delegated; customer tenants use the delegated Secure Application Model (the
    # engineer's refresh token redeemed against each customer authority). GDAP grants
    # the signed-in engineer's roles to these same delegated scopes - there are no
    # app-only (application-role) permissions anywhere in PatchPilot.
    #
    # READ-ONLY BY DEFAULT (invariant #11): the arrays below request only read scopes,
    # which are all sync needs. The Phase 5 remediation WRITE scopes are appended only
    # when -EnableRemediationWriteScopes is passed (see $remediation*WriteScopes).
    $graphScopes = @(
        "DelegatedAdminRelationship.Read.All",
        "SecurityEvents.Read.All",
        "Vulnerability.Read.All",
        # Reads /subscribedSkus for licensing detection over the home-tenant OBO
        # path. Without it the licensing probe 403s and the MSP tenant shows a
        # false "needs consent" with an empty Licenses column.
        "Organization.Read.All",
        "User.Read"
    )

    $defenderScopes = @(
        "Machine.Read.All",
        "Vulnerability.Read.All",
        # Reads /recommendations (Defender TVM security recommendations) so the
        # Vulnerabilities surface can consolidate per-CVE noise into one
        # "Update <product>" row per software. Without it that sync 403s and
        # PatchPilot falls back to the flat per-CVE list.
        "SecurityRecommendation.Read.All",
        # Reads /machines/{id}/getmissingkbs (per-device missing Windows Updates)
        # so the "By OS" tab can show real KB-level detail instead of the single
        # rolled-up "Microsoft Windows 11" recommendation. Without it that sync
        # 403s and missing_kbs stays empty.
        "Software.Read.All"
    )

    # ---- Phase 5 remediation WRITE scopes (opt-in; off by default) ----
    # These are the delegated scopes each remediation channel needs to issue a real
    # Microsoft write. They are documented here regardless, but only REQUESTED when
    # the operator passes -EnableRemediationWriteScopes. Even when granted, the
    # per-tenant `readOnly` flag still gates every write at execution time.
    $remediationGraphWriteScopes = @(
        # Win32-app channel: general device-management writes (create/assign the
        # Win32 app itself uses DeviceManagementApps.ReadWrite.All below; this one
        # backs the broader managedDevices read/write surface).
        "DeviceManagementManagedDevices.ReadWrite.All",
        # managedDevices/{id}/syncDevice (win32-app channel's post-assign device-sync
        # nudge) is documented as requiring THIS scope specifically, not
        # ReadWrite.All above — https://learn.microsoft.com/en-us/graph/api/intune-devices-manageddevice-syncdevice.
        # Without it every syncDevice call 403s even though ReadWrite.All covers
        # everything else this channel needs. Tenants that granted write scopes
        # before this was added need re-consent (same pattern as Group.Read.All).
        "DeviceManagementManagedDevices.PrivilegedOperations.All",
        # On-demand Intune remediation: initiateOnDemandProactiveRemediation targets a
        # remediation script policy (DeviceManagementConfiguration.ReadWrite.All).
        # Also load-bearing for Expedited Update: creates the per-device
        # deviceAndAppManagementAssignmentFilter used to scope a quality-update
        # profile to a single hostname.
        "DeviceManagementConfiguration.ReadWrite.All",
        # Win32 app content / assignment management (DeviceManagementApps.ReadWrite.All).
        "DeviceManagementApps.ReadWrite.All",
        # Expedited quality update: creates and assigns a windowsQualityUpdateProfile
        # (WindowsUpdates.ReadWrite.All). Load-bearing, not aspirational - this is
        # what actually dispatches an Expedited Update from the "By OS" tab.
        "WindowsUpdates.ReadWrite.All",
        # Deploy App form: resolves a typed "Assign to Custom Group"/"Exclude Groups"
        # name to its Entra object id (GET /groups?$filter=displayName eq '<name>').
        # Read-only itself, but grouped with the remediation write scopes since it is
        # only useful alongside DeviceManagementApps.ReadWrite.All. Tenants already
        # granted the write scopes before this was added need re-consent.
        "Group.Read.All"
    )
    $remediationDefenderWriteScopes = @(
        # Live Response channel: machines/{id}/runliveresponse (Machine.LiveResponse).
        "Machine.LiveResponse",
        # Live Response auto-provisioning: list/upload the parameterized winget script
        # to the tenant's library (GET/POST /libraryfiles) so onboarding needs no manual
        # Defender-portal upload. Without it the library list/upload 403s.
        "Library.Manage"
    )

    if ($EnableRemediationWriteScopes) {
        Write-WarningMessage "Requesting Phase 5 remediation WRITE scopes (-EnableRemediationWriteScopes). Writes remain gated by each tenant's read-only flag."
        $graphScopes    += $remediationGraphWriteScopes
        $defenderScopes += $remediationDefenderWriteScopes
    }
    else {
        Write-Info "Read-only install: remediation write scopes NOT requested. Re-run with -EnableRemediationWriteScopes to enable them."
    }

    $partnerCenterScopes = @(
        "user_impersonation"
    )

    $resourceAppIds = @{
        Graph         = "00000003-0000-0000-c000-000000000000"
        Defender      = "fc780465-2017-40d4-a0c5-307022471b92"
        PartnerCenter = "fa3d9a0c-3fb0-42cc-9193-47c7ecd2edbd"
    }

    $graphDelegated    = Resolve-ResourceAccess -ResourceName "Microsoft Graph" -ResourceAppId $resourceAppIds.Graph -ScopeValues $graphScopes
    $defenderDelegated = Resolve-ResourceAccess -ResourceName "Microsoft Defender" -ResourceAppId $resourceAppIds.Defender -ScopeValues $defenderScopes
    $partnerDelegated  = Resolve-ResourceAccess -ResourceName "Partner Center" -ResourceAppId $resourceAppIds.PartnerCenter -ScopeValues $partnerCenterScopes

    # Delegated-only: Resolve-ResourceAccess already returns the
    # { ResourceAppId, ResourceAccess } shape Graph's requiredResourceAccess expects,
    # one entry per resource. No app-role merge - there are no application permissions.
    $requiredResourceAccess = @(
        $graphDelegated
        $defenderDelegated
        $partnerDelegated
    ) | Where-Object { $_ }

    $requiredResourceAccess = @($requiredResourceAccess)

    if ($requiredResourceAccess.Count -eq 0) {
        Write-WarningMessage "No API permission sets were resolved. Skipping RequiredResourceAccess update."
    }
    else {
        if ($PSCmdlet.ShouldProcess($app.AppId, "Set API permissions")) {
            Update-MgApplication -ApplicationId $app.Id -RequiredResourceAccess $requiredResourceAccess
            Write-Success "Applied $($requiredResourceAccess.Count) permission set(s)."
        }
    }

    # ------------------------------------------------------------
    # 3. Expose PatchPilot API - idempotent and fixed
    # ------------------------------------------------------------

    Write-Step "[5/14] Exposing PatchPilot API..."

    $appIdUri = "api://$($app.AppId)"

    Write-Info "Refreshing app object..."
    $current = Get-MgApplication -ApplicationId $app.Id

    # 3a. Ensure Identifier URI exists
    $existingIdentifierUris = @()
    if ($current.IdentifierUris) {
        $existingIdentifierUris = @($current.IdentifierUris)
    }

    if ($existingIdentifierUris -notcontains $appIdUri) {
        Write-Info "Adding App ID URI: $appIdUri"

        $newIdentifierUris = @($existingIdentifierUris + $appIdUri | Select-Object -Unique)

        Update-MgApplication -ApplicationId $app.Id -IdentifierUris $newIdentifierUris
        Write-Success "App ID URI added."
    }
    else {
        Write-Success "App ID URI already exists."
    }

    # Refresh after Identifier URI update
    $current = Get-MgApplication -ApplicationId $app.Id

    # 3b. Ensure access_as_user scope exists
    $existingScopes = @()
    if ($current.Api -and $current.Api.Oauth2PermissionScopes) {
        $existingScopes = @($current.Api.Oauth2PermissionScopes)
    }

    $existingScope = $existingScopes |
        Where-Object { $_.Value -eq "access_as_user" } |
        Select-Object -First 1

    if ($existingScope) {
        $apiScopeId = $existingScope.Id
        Write-Success "API scope already exists: access_as_user ($apiScopeId)"
    }
    else {
        $apiScopeId = [guid]::NewGuid().ToString()
        Write-Info "Creating new access_as_user scope ID: $apiScopeId"

        $newScope = @{
            Id                      = $apiScopeId
            Value                   = "access_as_user"
            Type                    = "User"
            IsEnabled               = $true
            AdminConsentDisplayName = "Access PatchPilot"
            AdminConsentDescription = "Allow PatchPilot to act as the signed-in engineer."
            UserConsentDisplayName  = "Access PatchPilot"
            UserConsentDescription  = "Allow PatchPilot to act as you when managing tenants."
        }

        $updatedScopes = @($existingScopes + $newScope)

        # Important: create/commit the scope first. Do not pre-authorise in the same call.
        Update-MgApplication -ApplicationId $app.Id -Api @{
            Oauth2PermissionScopes = $updatedScopes
        }

        Write-Success "API scope created: access_as_user"
    }

    # Refresh after scope update so Graph can validate the scope ID
    $current = Get-MgApplication -ApplicationId $app.Id

    # 3c. Ensure self pre-authorisation exists, without duplicating it
    $existingPreAuthApps = @()
    if ($current.Api -and $current.Api.PreAuthorizedApplications) {
        $existingPreAuthApps = @($current.Api.PreAuthorizedApplications)
    }

    $matchingPreAuth = $existingPreAuthApps |
        Where-Object { $_.AppId -eq $app.AppId } |
        Select-Object -First 1

    $preAuthAlreadyExists = $false

    if ($matchingPreAuth) {
        if ($matchingPreAuth.DelegatedPermissionIds -contains $apiScopeId) {
            $preAuthAlreadyExists = $true
        }
    }

    if ($preAuthAlreadyExists) {
        Write-Success "Pre-authorisation already exists."
    }
    else {
        Write-Info "Adding pre-authorisation for PatchPilot client."

        $newPreAuthApps = @()

        foreach ($preAuth in $existingPreAuthApps) {
            if ($preAuth.AppId -eq $app.AppId) {
                $existingPermissionIds = @()
                if ($preAuth.DelegatedPermissionIds) {
                    $existingPermissionIds = @($preAuth.DelegatedPermissionIds)
                }

                if ($existingPermissionIds -notcontains $apiScopeId) {
                    $existingPermissionIds += $apiScopeId
                }

                $newPreAuthApps += @{
                    AppId                  = $preAuth.AppId
                    DelegatedPermissionIds = @($existingPermissionIds | Select-Object -Unique)
                }
            }
            else {
                $newPreAuthApps += @{
                    AppId                  = $preAuth.AppId
                    DelegatedPermissionIds = @($preAuth.DelegatedPermissionIds)
                }
            }
        }

        if (-not $matchingPreAuth) {
            $newPreAuthApps += @{
                AppId                  = $app.AppId
                DelegatedPermissionIds = @($apiScopeId)
            }
        }

        # Important: pre-authorisation happens only after the scope exists and has been refreshed.
        Update-MgApplication -ApplicationId $app.Id -Api @{
            PreAuthorizedApplications = $newPreAuthApps
        }

        Write-Success "Pre-authorisation added."
    }

    Write-Success "App ID URI: $appIdUri"
    Write-Success "Scope: $appIdUri/access_as_user"

    # ------------------------------------------------------------
    # 4. Redirect URIs
    # ------------------------------------------------------------

    Write-Step "[6/14] Setting redirect URIs..."

    $current = Get-MgApplication -ApplicationId $app.Id

    $currentWebUris = @()
    if ($current.Web -and $current.Web.RedirectUris) {
        $currentWebUris = @($current.Web.RedirectUris)
    }

    $currentSpaUris = @()
    if ($current.Spa -and $current.Spa.RedirectUris) {
        $currentSpaUris = @($current.Spa.RedirectUris)
    }

    $mergedWebUris = Merge-RedirectUris -ExistingUris $currentWebUris -NewUri $RedirectUri

    # Confidential client: the redirect URI must live on the Web platform ONLY.
    # If it is also present on the SPA platform, Entra matches it as cross-origin and
    # enforces PKCE (AADSTS9002325). Strip it from SPA so the server-side flow works.
    $strippedSpaUris = @($currentSpaUris | Where-Object { $_ -ne $RedirectUri })

    $webNeedsUpdate = -not (Test-RedirectUriExists -Application $current -Uri $RedirectUri -Platform "Web")
    $spaNeedsCleanup = (Test-RedirectUriExists -Application $current -Uri $RedirectUri -Platform "Spa")

    if (-not $webNeedsUpdate -and -not $spaNeedsCleanup) {
        Write-Success "Redirect URI already correct on Web platform (not on SPA)."
    }
    else {
        if ($PSCmdlet.ShouldProcess($app.AppId, "Update redirect URIs")) {
            if ($webNeedsUpdate) {
                Update-MgApplication -ApplicationId $app.Id -Web @{
                    RedirectUris = $mergedWebUris
                }

                Write-Success "Web redirect URI updated."
            }

            if ($spaNeedsCleanup) {
                Update-MgApplication -ApplicationId $app.Id -Spa @{
                    RedirectUris = $strippedSpaUris
                }

                Write-Success "Removed redirect URI from SPA platform (PKCE conflict fix)."
            }
        }
    }

    # ------------------------------------------------------------
    # 5. Client secret
    # ------------------------------------------------------------

    Write-Step "[7/14] Checking client secret..."

    $current = Get-MgApplication -ApplicationId $app.Id

    $existingPasswordCredentials = @()
    if ($current.PasswordCredentials) {
        $existingPasswordCredentials = @($current.PasswordCredentials)
    }

    $validExistingPatchPilotSecrets = @(
        $existingPasswordCredentials |
            Where-Object {
                $_.DisplayName -like "PatchPilot-Deploy-*" -and
                $_.EndDateTime -gt (Get-Date).AddDays(7)
            }
    )

    if ($RotateClientSecret) {
        Write-WarningMessage "RotateClientSecret specified. A new secret will be generated."
    }

    if ($validExistingPatchPilotSecrets.Count -gt 0 -and -not $RotateClientSecret) {
        Write-Success "Existing valid PatchPilot client secret found. No new secret generated."
        Write-WarningMessage "Existing client secret values cannot be retrieved from Entra ID. Use -RotateClientSecret if you need a new value for .env."
    }
    else {
        if ($PSCmdlet.ShouldProcess($app.AppId, "Add password credential")) {
            $secret = Add-MgApplicationPassword -ApplicationId $app.Id -PasswordCredential @{
                DisplayName = "PatchPilot-Deploy-{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss")
                EndDateTime = (Get-Date).AddDays(90)
            }

            Write-Host ""
            Write-Host "    ===== COPY THIS SECRET NOW =====" -ForegroundColor Red
            Write-Host "    Client ID:     $($app.AppId)" -ForegroundColor Yellow
            Write-Host "    Client Secret: $($secret.SecretText)" -ForegroundColor Yellow
            Write-Host "    Expires:       $($secret.EndDateTime)" -ForegroundColor Yellow
            Write-Host "    =================================" -ForegroundColor Red
        }
    }

    # ------------------------------------------------------------
    # 6. Create or reuse local service principal
    # ------------------------------------------------------------

    Write-Step "[8/14] Creating or reusing local service principal..."

    $localSps = @(Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'" -ErrorAction SilentlyContinue)

    if ($localSps.Count -gt 0) {
        $sp = $localSps[0]
        Write-Success "Existing local service principal found: $($sp.Id)"
    }
    else {
        try {
            $sp = New-MgServicePrincipal -AppId $app.AppId
            Write-Success "Created local service principal: $($sp.Id)"
        }
        catch {
            Write-WarningMessage "Could not create local service principal: $($_.Exception.Message)"
            $sp = $null
        }
    }

    # ------------------------------------------------------------
    # 9. Admin consent for delegated permissions (one-time, interactive)
    # ------------------------------------------------------------

    Write-Step "[9/14] Admin consent for delegated permissions..."

    # PatchPilot is delegated-only: every Graph/Defender call carries the signed-in
    # engineer's identity (home tenant via OBO, customers via the Secure Application
    # Model). There are NO application (app-only) roles to assign here. The delegated
    # scopes declared in step [4/13] only take effect once they are admin-consented in
    # THIS partner tenant - otherwise the home-tenant OBO token silently lacks them and
    # licensing (Organization.Read.All) 403s with an empty Licenses column.
    #
    # We grant that consent programmatically and idempotently here so it always matches
    # the current permission set: a re-run after adding a scope re-consents it, with no
    # human clicking a URL. This single partner-tenant consent covers all GDAP customers
    # - no per-customer admin consent and no per-customer SP provisioning is required.
    # If the admin running this script lacks rights to write the grant, we degrade to the
    # printed /adminconsent URL (the same one Setup -> App Registration surfaces).
    $homeConsentGranted = $false
    if (-not $sp) {
        Write-WarningMessage "No local service principal - the app cannot be consented until one exists."
    }
    elseif ($PSCmdlet.ShouldProcess($MspTenantId, "Grant home-tenant admin consent for delegated scopes")) {
        $consentResults = @(
            Set-DelegatedAdminConsent -ClientSpId $sp.Id -ResourceName "Microsoft Graph" -ResourceAppId $resourceAppIds.Graph -ScopeValues $graphScopes
            Set-DelegatedAdminConsent -ClientSpId $sp.Id -ResourceName "Microsoft Defender" -ResourceAppId $resourceAppIds.Defender -ScopeValues $defenderScopes
            Set-DelegatedAdminConsent -ClientSpId $sp.Id -ResourceName "Partner Center" -ResourceAppId $resourceAppIds.PartnerCenter -ScopeValues $partnerCenterScopes
        )
        # Consent is "done" only if every resource that should be consented succeeded.
        $homeConsentGranted = ($consentResults.Count -gt 0) -and (-not ($consentResults -contains $false))
        if ($homeConsentGranted) {
            Write-Success "Home-tenant admin consent granted programmatically - no manual consent URL needed."
        }
        else {
            Write-WarningMessage "Some scopes were not auto-consented. Use the admin-consent URL in the summary to finish."
        }
    }

    # ------------------------------------------------------------
    # 10. GDAP enumeration
    # ------------------------------------------------------------

    Write-Step "[10/14] Enumerating GDAP tenants..."

    $relationships = @()

    try {
        Write-Info "Querying active GDAP relationships."

        $relationships = @(Get-MgTenantRelationshipDelegatedAdminRelationship -Filter "status eq 'active'" -All)

        Write-Success "Found $($relationships.Count) active GDAP relationship(s)."
    }
    catch {
        Write-WarningMessage "GDAP enumeration failed: $($_.Exception.Message)"
        $relationships = @()
    }

    # ------------------------------------------------------------
    # 11. Customer access (delegated GDAP - no provisioning needed)
    # ------------------------------------------------------------

    Write-Step "[11/14] Confirming customer-access model (delegated GDAP)..."

    # Customer access is delegated, via the Secure Application Model: each
    # customer-tenant token is minted from the signed-in engineer's refresh token and
    # inherits THAT ENGINEER's GDAP roles. Nothing is provisioned per customer here -
    # no service principal added to a GDAP security group (Entra no longer grants
    # directory roles to an *application* via relationships/group membership), and no
    # per-customer admin consent. An engineer reaches a customer the moment they hold
    # an active GDAP role for it; Discover/Sync then surface it as Reachable.
    if ($relationships.Count -eq 0) {
        Write-WarningMessage "No active GDAP relationships were returned for this partner tenant."
    }
    else {
        Write-Success "$($relationships.Count) GDAP customer(s) reachable via delegated engineer roles - no per-customer provisioning required."
    }

    # ------------------------------------------------------------
    # 12. Consent URLs
    # ------------------------------------------------------------

    Write-Step "[12/14] Generating customer consent URLs..."

    $rows = foreach ($r in $relationships) {
        $customerName = $null
        $customerTenantId = $null

        if ($r.Customer) {
            $customerName = $r.Customer.DisplayName
            $customerTenantId = $r.Customer.TenantId
        }

        if ([string]::IsNullOrWhiteSpace($customerTenantId)) {
            Write-WarningMessage "Skipping relationship because CustomerTenantId was empty."
            continue
        }

        $encodedRedirectUri = [System.Uri]::EscapeDataString($RedirectUri)

        [pscustomobject]@{
            CustomerName     = $customerName
            CustomerTenantId = $customerTenantId
            ConsentUrl       = "https://login.microsoftonline.com/$customerTenantId/adminconsent?client_id=$($app.AppId)&redirect_uri=$encodedRedirectUri&state=patchpilot-onboarding"
            Status           = "Pending"
        }
    }

    $rows = @($rows)

    $csvPath = Join-Path $OutputFolder "patchpilot-consent-urls.csv"

    $rows | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8

    Write-Success "Wrote consent URL CSV: $csvPath"

    if ($rows.Count -eq 0) {
        Write-WarningMessage "No customer consent URLs were generated because no active GDAP customers were returned."
    }

    # ------------------------------------------------------------
    # 13. Write .env
    # ------------------------------------------------------------

    Write-Step "[13/14] Writing .env file..."

    if (-not $secret) {
        Write-WarningMessage "Skipped .env secret update because no new client secret was generated."
        Write-WarningMessage "If you need a fresh .env with a new secret, re-run with -RotateClientSecret."
    }
    else {
        if ($PSScriptRoot) {
            $repoRoot = Split-Path $PSScriptRoot -Parent
        }
        else {
            $repoRoot = Get-Location
        }

        $envPath = Join-Path $repoRoot ".env"

        if (Test-Path $envPath) {
            $envPath = Join-Path $repoRoot ".env.generated"
            Write-WarningMessage "Existing .env found. Writing .env.generated instead."
        }

        $sessionSecret = New-Base64Key
        $tokenKey      = New-Base64Key
        $pgPassword    = New-Base64Key

        # PUBLIC_URL and CORS_ORIGINS are origins (scheme://host:port) - the
        # browser's Origin header never carries a path, so a full redirect URI
        # here would fail CORS. Derive the origin from the redirect URI.
        $redirectOrigin = ([System.Uri]$RedirectUri).GetLeftPart([System.UriPartial]::Authority)

        # Base64 passwords can contain + / = which corrupt a raw connection URL;
        # percent-encode the password where it is embedded in DATABASE_URL.
        $pgPasswordEnc = [System.Uri]::EscapeDataString($pgPassword)

        $envContent = @"
PUBLIC_URL=$redirectOrigin
AUTH_REDIRECT_URI=$RedirectUri

ENTRA_TENANT_ID=$MspTenantId
ENTRA_CLIENT_ID=$($app.AppId)
ENTRA_CLIENT_SECRET=$($secret.SecretText)

SESSION_SECRET=$sessionSecret
TOKEN_ENCRYPTION_KEY=$tokenKey

POSTGRES_USER=patchpilot
POSTGRES_PASSWORD=$pgPassword
POSTGRES_DB=patchpilot
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
DATABASE_URL=postgres://patchpilot:$pgPasswordEnc@postgres:5432/patchpilot

REDIS_HOST=redis
REDIS_PORT=6379
REDIS_URL=redis://redis:6379

API_PORT=4000
CORS_ORIGINS=$redirectOrigin

DEMO_MODE=false
LOG_LEVEL=info
"@

        if ($PSCmdlet.ShouldProcess($envPath, "Write .env file")) {
            Set-Content -Path $envPath -Value $envContent -Encoding UTF8

            try {
                icacls $envPath /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
            }
            catch {
                Write-WarningMessage "Could not lock down .env permissions with icacls: $($_.Exception.Message)"
            }

            Write-Success "Wrote env file: $envPath"
        }
    }

    # ------------------------------------------------------------
    # 14. Phone home (hosted SaaS pairing only)
    # ------------------------------------------------------------

    Write-Step "[14/14] Pairing with hosted instance..."

    # An un-substituted template placeholder (the checked-in default - see the
    # param block above) means this is a plain, unmodified copy of the script,
    # not one downloaded from an instance's Setup page. Treat that exactly
    # like "not supplied", not like a real (and doomed-to-fail) pairing target.
    # Checked via StartsWith/EndsWith, not an exact literal match against the
    # placeholder text: the server's substitution (onboarding-pairing.ts) is a
    # global replace across the whole file, so spelling out either exact
    # placeholder again here (rather than describing them as "{{...}}") would
    # get it rewritten right along with the param defaults above, and this
    # check would then always compare the substituted real value against
    # itself - always true, so pairing would silently never fire on a real
    # personalized download. (This is exactly that latent bug, now fixed - it
    # predates the $RedirectUri templating added alongside this comment.)
    #
    # $RedirectUri deliberately isn't part of this gate: by now it has always
    # already resolved to a real, usable value (either the substituted real
    # URI or the localhost fallback near the top of the script), and it's
    # used earlier for the app registration itself - not specific to this
    # phone-home step the way $InstanceUrl/$PairingToken are.
    $pairingRequested = $InstanceUrl -and $PairingToken `
        -and -not ($InstanceUrl.StartsWith("{{") -and $InstanceUrl.EndsWith("}}")) `
        -and -not ($PairingToken.StartsWith("{{") -and $PairingToken.EndsWith("}}"))

    if (-not $pairingRequested) {
        Write-Host "  Skipped - no -InstanceUrl/-PairingToken supplied (self-hosted .env config above is authoritative)." -ForegroundColor DarkGray
    }
    elseif (-not $secret) {
        Write-WarningMessage "Skipped pairing because no new client secret was generated. Re-run with -RotateClientSecret to pair."
    }
    else {
        # This is the script's first-ever outbound HTTP call to anything other
        # than Microsoft Graph - a new trust boundary. $InstanceUrl is the
        # customer's own PatchPilot instance (self-hosted or vendor-hosted);
        # $PairingToken is a single-use, 30-minute-TTL credential minted by that
        # instance's Setup page (apps/api/src/routes/onboarding-pairing.ts) and
        # baked into this script's defaults when downloaded from there. It is
        # the ONLY authentication this request carries - there is no session,
        # and none is needed.
        $pairingBody = @{
            token        = $PairingToken
            clientId     = $app.AppId
            tenantId     = $MspTenantId
            clientSecret = $secret.SecretText
        } | ConvertTo-Json

        if ($PSCmdlet.ShouldProcess("$InstanceUrl/api/onboarding/pair", "Send Entra app registration credentials")) {
            try {
                Invoke-RestMethod -Method Post -Uri "$InstanceUrl/api/onboarding/pair" -Body $pairingBody -ContentType "application/json" | Out-Null
                Write-Success "Paired with $InstanceUrl - it will restart momentarily with these credentials."
            }
            catch {
                Write-WarningMessage "Pairing request to $InstanceUrl failed: $($_.Exception.Message)"
                Write-WarningMessage "The app registration above was still created successfully. Re-run with the same -InstanceUrl/-PairingToken to retry pairing, or configure the instance manually with the .env values above."
            }
        }
    }

    # ------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host " Done! Summary"                         -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  App registration: $($app.AppId)"
    Write-Host "  App object ID:     $($app.Id)"
    Write-Host "  App ID URI:        api://$($app.AppId)"
    Write-Host "  Scope:             api://$($app.AppId)/access_as_user"
    Write-Host "  Redirect URI:      $RedirectUri"
    Write-Host "  Consent CSV:       $csvPath"

    if ($envPath) {
        Write-Host "  Env file:          $envPath"
    }
    else {
        Write-Host "  Env file:          Not written this run"
    }

    if ($transcriptPath) {
        Write-Host "  Transcript:        $transcriptPath"
    }

    Write-Host ""
    Write-Host "  This run also (idempotently):" -ForegroundColor Yellow
    Write-Host "    - Registered PatchPilot's delegated Graph/Defender permissions in this tenant."
    Write-Host "    - Confirmed your GDAP customers are reachable via delegated engineer roles"
    Write-Host "      (no per-customer provisioning - the Secure Application Model needs none)."
    Write-Host ""

    # Partner-tenant admin consent. PatchPilot is delegated-only, so its delegated
    # scopes must be admin-consented in the MSP's OWN tenant, or the first Discover
    # returns 403 with an empty Licenses column. Step [9/13] already grants this
    # programmatically (and re-grants on every run, so adding a scope later self-heals).
    # The URL below is the manual fallback for when the deploying admin lacked rights to
    # write the grant - same /adminconsent flow the web console surfaces (Setup -> App
    # Registration, "Grant admin consent"). A single consent covers all GDAP customers.
    # Carries only the public client id (never a secret).
    $homeConsentUrl = "https://login.microsoftonline.com/$MspTenantId/adminconsent?client_id=$($app.AppId)&redirect_uri=$([System.Uri]::EscapeDataString($RedirectUri))&state=patchpilot-onboarding"
    if ($homeConsentGranted) {
        Write-Host "  MSP tenant admin consent: granted programmatically by this run. No action needed." -ForegroundColor Green
        Write-Host "  Fallback URL (only if consent ever needs re-granting by hand):" -ForegroundColor DarkGray
        Write-Host "    $homeConsentUrl" -ForegroundColor DarkGray
    }
    else {
        Write-Host "  Grant MSP tenant admin consent (Global Administrator):" -ForegroundColor Yellow
        Write-Host "    $homeConsentUrl" -ForegroundColor Cyan
        Write-Host "    (Or do it in the app: Setup -> App Registration -> 'Grant admin consent'.)"
    }
    Write-Host ""
    Write-Host "  Next:" -ForegroundColor Yellow
    Write-Host "    1. If a new client secret was generated, copy it now."
    Write-Host "    2. Review .env or .env.generated if written."
    Write-Host "    3. Run docker compose up -d from the PatchPilot repo."
    if (-not $homeConsentGranted) {
        Write-Host "    4. Open the consent URL above as a Global Administrator to authorize PatchPilot."
    }
    Write-Host "    5. Send each customer their generated admin consent URL (Setup -> App Registration shows status)."
    Write-Host "    6. In PatchPilot, run Discover to confirm your tenant and each customer are Reachable."
    Write-Host ""
}
catch {
    Write-Host ""
    Write-Host "Deployment failed:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""

    if ($transcriptPath) {
        Write-Host "Transcript path, if created: $transcriptPath" -ForegroundColor Yellow
    }

    throw
}
finally {
    if ($transcriptStarted) {
        try {
            Stop-Transcript | Out-Null
        }
        catch {
            # Ignore transcript shutdown errors
        }
    }
}
