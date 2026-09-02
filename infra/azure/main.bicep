// PatchPilot — single-template Azure VM deployment.
// Deploy with: az deployment group create -g <rg> --template-file main.bicep
// (see infra/azure/README.md for the full command). Creates the network, NSG,
// a DNS-labeled static public IP, and an Ubuntu VM that provisions itself via
// cloud-init.yaml — no SSH needed for setup.

@description('Azure region. Defaults to the resource group\'s own region.')
param location string = resourceGroup().location

@description('DNS label for the free <label>.<region>.cloudapp.azure.com hostname. Must be globally unique within the region.')
param dnsLabel string

@description('Custom domain (e.g. patchpilot.yourdomain.com). No default on purpose: omitting it from --parameters makes az deployment group create prompt for it interactively — press Enter to leave it blank and use the free cloudapp.azure.com hostname instead. You can switch later without redeploying.')
param customDomain string

@description('Admin username for the VM (used only for break-glass SSH access).')
param adminUsername string = 'azureuser'

@description('SSH public key content for the admin user.')
param sshPublicKey string

@description('CIDR allowed to reach SSH (22), e.g. "1.2.3.4/32". Use "*" to allow any source (not recommended).')
param allowedSshSourceIp string

@description('VM size. B2ms (2 vCPU/8GB) is comfortable for the full stack with AI features off.')
param vmSize string = 'Standard_B2ms'

var vmName = 'patchpilot-vm'
var resolvedDomain = empty(customDomain) ? publicIp.properties.dnsSettings.fqdn : customDomain
var cloudInitRaw = loadTextContent('cloud-init.yaml')
var cloudInitFilled = replace(replace(cloudInitRaw, '__PP_DOMAIN__', resolvedDomain), '__ADMIN_USER__', adminUsername)

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

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' = {
  name: 'patchpilot-nsg'
  location: location
  properties: {
    securityRules: [
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
      {
        // Break-glass only — the deploy plan never relies on SSH for setup
        // or day-to-day operation (that all goes through `az vm run-command`).
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
