// PatchPilot — single-template Azure VM deployment.
// Deploy with: az deployment group create -g <rg> --template-file main.bicep
// (see infra/azure/README.md for the full command). Creates the network, NSG,
// a DNS-labeled static public IP, and an Ubuntu VM that provisions itself via
// cloud-init.yaml — no SSH needed for setup.

@description('Azure region to deploy into. Defaults to Australia East; change it to deploy elsewhere.')
param location string = 'australiaeast'

@description('DNS label for the free <label>.<region>.cloudapp.azure.com hostname. Must be globally unique within the region. Defaults to a generated value so a one-click deploy doesn\'t require inventing a globally-unique name.')
param dnsLabel string = 'patchpilot-${uniqueString(resourceGroup().id)}'

@description('Custom domain (e.g. patchpilot.yourdomain.com). Leave blank to use the free cloudapp.azure.com hostname instead. You can switch later without redeploying.')
param customDomain string = ''

@description('Admin username for the VM (used only for break-glass SSH access).')
param adminUsername string = 'ppadmin'

@description('Enable inbound SSH (port 22) for break-glass access. PatchPilot never needs SSH for setup or day-to-day operation (az vm run-command is used instead) — leave this off to shrink the deploy form.')
param enableSsh bool = false

@description('SSH public key content for the admin user. Always required by the VM resource (Azure Linux VMs need a credential even with password auth disabled), but network-unreachable unless enableSsh is true. Defaults to a placeholder key with no known private key anywhere — safe only because enableSsh defaults to false (no NSG rule opens port 22, so the key can never actually be used). If you set enableSsh to true, you MUST override this with your own public key or the VM will be unreachable via SSH — the placeholder locks you out, it does not grant anyone access.')
param sshPublicKey string = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF38BzZ5aspSurxUU6/kjxpCBVwyAl5XwKg6uc8C9jre patchpilot-placeholder-inert-key'

@description('CIDR allowed to reach SSH (22) when enableSsh is true, e.g. "1.2.3.4/32". Use "*" to allow any source (not recommended). Ignored when enableSsh is false.')
param allowedSshSourceIp string = '*'

@description('VM size. Standard_B2as_v2 (2 vCPU/8GB) is comfortable for the full stack with AI features off. Use Standard_B4as_v2 (4 vCPU/16GB) if you plan to enable local AI (Ollama + llama3.1:8b).')
param vmSize string = 'Standard_B2as_v2'

@description('Git repository URL to clone onto the VM. Point this at your own fork to deploy custom code instead of upstream mkheagerty-lab/PatchPilot.')
param repoUrl string = 'https://github.com/mkheagerty-lab/PatchPilot.git'

@description('Git branch or tag to check out after cloning repoUrl.')
param repoRef string = 'main'

var vmName = 'patchpilot-vm'
var resolvedDomain = empty(customDomain) ? publicIp.properties.dnsSettings.fqdn : customDomain
var cloudInitRaw = loadTextContent('cloud-init.yaml')
var cloudInitFilled = replace(replace(replace(replace(cloudInitRaw, '__PP_DOMAIN__', resolvedDomain), '__ADMIN_USER__', adminUsername), '__REPO_URL__', repoUrl), '__REPO_REF__', repoRef)

resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' = {
  name: 'patchpilot-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: ['10.20.0.0/24']
    }
    subnets: [
      {
        name: 'default'
        properties: {
          addressPrefix: '10.20.0.0/26'
          networkSecurityGroup: {
            id: nsg.id
          }
        }
      }
    ]
  }
}

var baseSecurityRules = [
  {
    name: 'AllowHTTP'
    properties: {
      priority: 100
      direction: 'Inbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourcePortRange: '*'
      destinationPortRange: '80'
      sourceAddressPrefix: '*'
      destinationAddressPrefix: '*'
    }
  }
  {
    name: 'AllowHTTPS'
    properties: {
      priority: 110
      direction: 'Inbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourcePortRange: '*'
      destinationPortRange: '443'
      sourceAddressPrefix: '*'
      destinationAddressPrefix: '*'
    }
  }
]

// Break-glass only — the deploy plan never relies on SSH for setup or
// day-to-day operation (that all goes through `az vm run-command`). Only
// added to the NSG when enableSsh is true; otherwise the implicit
// DenyAllInBound rule blocks port 22 regardless of the VM's SSH key.
var sshSecurityRule = [
  {
    name: 'AllowSSHFromAdmin'
    properties: {
      priority: 120
      direction: 'Inbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourcePortRange: '*'
      destinationPortRange: '22'
      sourceAddressPrefix: allowedSshSourceIp
      destinationAddressPrefix: '*'
    }
  }
]

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' = {
  name: 'patchpilot-nsg'
  location: location
  properties: {
    securityRules: enableSsh ? concat(baseSecurityRules, sshSecurityRule) : baseSecurityRules
  }
}

resource publicIp 'Microsoft.Network/publicIPAddresses@2023-09-01' = {
  name: 'patchpilot-ip'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    dnsSettings: {
      domainNameLabel: dnsLabel
    }
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2023-09-01' = {
  name: 'patchpilot-nic'
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          subnet: {
            id: vnet.properties.subnets[0].id
          }
          privateIPAllocationMethod: 'Dynamic'
          publicIPAddress: {
            id: publicIp.id
          }
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-03-01' = {
  name: vmName
  location: location
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      customData: base64(cloudInitFilled)
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: sshPublicKey
            }
          ]
        }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: '0001-com-ubuntu-server-jammy'
        sku: '22_04-lts-gen2'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        managedDisk: {
          storageAccountType: 'StandardSSD_LRS'
        }
        diskSizeGB: 64
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
        }
      ]
    }
  }
}

output fqdn string = resolvedDomain
output publicIpAddress string = publicIp.properties.ipAddress
output url string = 'https://${resolvedDomain}'
