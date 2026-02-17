const BOT_IMAGE_PATTERN = /^[\w.\-/]+(:[\w.-]+)?$/;

/**
 * Generate the cloud-init user-data script for a new WOPR node.
 * Installs Docker, pulls the bot image, and writes a ready marker.
 */
export function generateCloudInit(botImage: string): string {
  if (!BOT_IMAGE_PATTERN.test(botImage)) {
    throw new Error(`Invalid botImage: ${botImage}`);
  }
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
