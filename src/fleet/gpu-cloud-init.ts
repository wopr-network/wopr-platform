const NODE_ID_PATTERN = /^[\w-]+$/;
const URL_PATTERN = /^https?:\/\/[\w./:]+$/;
const SECRET_PATTERN = /^[\w._~-]+$/;
const MODEL_NAME_PATTERN = /^[\w./-]+$/;

export interface GpuCloudInitParams {
  nodeId: string;
  platformUrl: string;
  gpuNodeSecret: string;
  modelConfig?: {
    llamaModel?: string;
    qwenModel?: string;
    whisperModel?: string;
  };
}

const DEFAULT_LLAMA_MODEL = "TheBloke/Llama-2-7B-Chat-GGUF";
const DEFAULT_QWEN_MODEL = "Qwen/Qwen2.5-7B-Instruct-GGUF";
const DEFAULT_WHISPER_MODEL = "Systran/faster-whisper-base.en";

export function generateGpuCloudInit(params: GpuCloudInitParams): string {
  if (!NODE_ID_PATTERN.test(params.nodeId)) {
    throw new Error(`Invalid nodeId: ${params.nodeId}`);
  }
  if (!URL_PATTERN.test(params.platformUrl)) {
    throw new Error(`Invalid platformUrl: ${params.platformUrl}`);
  }
  if (!SECRET_PATTERN.test(params.gpuNodeSecret)) {
    throw new Error(`Invalid gpuNodeSecret`);
  }

  const llama = params.modelConfig?.llamaModel ?? DEFAULT_LLAMA_MODEL;
  const qwen = params.modelConfig?.qwenModel ?? DEFAULT_QWEN_MODEL;
  const whisper = params.modelConfig?.whisperModel ?? DEFAULT_WHISPER_MODEL;

  if (!MODEL_NAME_PATTERN.test(llama)) throw new Error(`Invalid model name: ${llama}`);
  if (!MODEL_NAME_PATTERN.test(qwen)) throw new Error(`Invalid model name: ${qwen}`);
  if (!MODEL_NAME_PATTERN.test(whisper)) throw new Error(`Invalid model name: ${whisper}`);

  const baseUrl = params.platformUrl.replace(/\/+$/, "");
  const nodeId = params.nodeId;
  const secret = params.gpuNodeSecret;

  const pingCmd = (stage: string) =>
    `curl -sf -X POST "${baseUrl}/internal/gpu/register?stage=${stage}" -H "Authorization: Bearer ${secret}" -H "Content-Type: application/json" -d '{"nodeId":"${nodeId}"}'`;

  return `#cloud-config
runcmd:
  - apt-get update
  - DEBIAN_FRONTEND=noninteractive apt-get install -y nvidia-driver-535 nvidia-container-toolkit
  - ${pingCmd("installing_drivers")}
  - apt-get install -y docker.io docker-compose-v2
  - systemctl enable docker
  - systemctl start docker
  - nvidia-ctk runtime configure --runtime=docker --set-as-default
  - systemctl restart docker
  - ${pingCmd("installing_docker")}
  - mkdir -p /opt/models
  - docker pull ghcr.io/ggerganov/llama.cpp:server --platform linux/amd64 || true
  - apt-get install -y python3-pip
  - pip3 install huggingface_hub
  - huggingface-cli download ${llama} --local-dir /opt/models/llama
  - huggingface-cli download ${qwen} --local-dir /opt/models/qwen
  - huggingface-cli download ${whisper} --local-dir /opt/models/whisper
  - ${pingCmd("downloading_models")}
  - mkdir -p /opt/wopr-gpu
  - |
    cat > /opt/wopr-gpu/docker-compose.gpu.yml << 'COMPOSE'
    version: "3.8"
    services:
      llama:
        image: ghcr.io/ggerganov/llama.cpp:server
        deploy:
          resources:
            reservations:
              devices:
                - capabilities: [gpu]
        volumes:
          - /opt/models/llama:/models
        ports:
          - "8080:8080"
        command: ["-m", "/models/*.gguf", "--host", "0.0.0.0", "--port", "8080"]
        restart: unless-stopped
      whisper:
        image: fedirz/faster-whisper-server:latest-cuda
        deploy:
          resources:
            reservations:
              devices:
                - capabilities: [gpu]
        volumes:
          - /opt/models/whisper:/models
        ports:
          - "8082:8000"
        environment:
          - WHISPER__MODEL=/models
        restart: unless-stopped
    COMPOSE
  - |
    cat > /opt/wopr-gpu/.env << 'ENVFILE'
    NODE_ID=${nodeId}
    PLATFORM_URL=${baseUrl}
    GPU_NODE_SECRET=${secret}
    ENVFILE
  - cd /opt/wopr-gpu && docker compose -f docker-compose.gpu.yml up -d
  - ${pingCmd("starting_services")}
  - ${pingCmd("done")}
`;
}
