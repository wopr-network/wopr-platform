export interface SharedVolumeConfig {
  enabled: boolean;
  volumeName: string;
  mountPath: string;
}

export function getSharedVolumeConfig(): SharedVolumeConfig {
  return {
    enabled: process.env.SHARED_NODE_MODULES_ENABLED !== "false",
    volumeName: process.env.SHARED_NODE_MODULES_VOLUME || "wopr-shared-node-modules",
    mountPath: process.env.SHARED_NODE_MODULES_MOUNT || "/shared/node_modules",
  };
}
