const BOT_IMAGE_PATTERN = /^[\w.\-/]+(:[\w.-]+)?$/;

/**
 * Generate the cloud-init user-data script for a new WOPR node.
 * Installs Docker, pulls the bot image, and writes a ready marker.
 * Optionally injects a per-node secret as WOPR_NODE_SECRET env var.
 */
export function generateCloudInit(botImage: string, nodeSecret?: string): string {
  if (!BOT_IMAGE_PATTERN.test(botImage)) {
    throw new Error(`Invalid botImage: ${botImage}`);
  }
  const secretLine = nodeSecret ? `  - echo "WOPR_NODE_SECRET=${nodeSecret}" >> /etc/environment\n` : "";
  return `#cloud-config
packages:
  - docker.io
  - docker-compose-v2

runcmd:
  - systemctl enable docker
  - systemctl start docker
${secretLine}  - docker pull ${botImage}
  - echo "WOPR_NODE_READY" > /tmp/wopr-ready
`;
}
