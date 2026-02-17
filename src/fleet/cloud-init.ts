/**
 * Generate the cloud-init user-data script for a new WOPR node.
 * Installs Docker, pulls the bot image, and writes a ready marker.
 */
export function generateCloudInit(botImage: string): string {
  return `#cloud-config
packages:
  - docker.io
  - docker-compose-v2

runcmd:
  - systemctl enable docker
  - systemctl start docker
  - docker pull ${botImage}
  - echo "WOPR_NODE_READY" > /tmp/wopr-ready
`;
}
