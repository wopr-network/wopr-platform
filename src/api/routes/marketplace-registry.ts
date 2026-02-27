// src/api/routes/marketplace-registry.ts
// Authoritative plugin registry served by GET /api/marketplace/plugins.
// In the future, this will be backed by a database or remote registry service.
// For now, it's a static list that matches the UI's expected manifest format.

export type PluginCategory =
  | "channel"
  | "provider"
  | "voice"
  | "memory"
  | "context"
  | "webhook"
  | "integration"
  | "ui"
  | "moderation"
  | "analytics";

export interface ConfigSchemaField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "select";
  required: boolean;
  secret?: boolean;
  env?: string;
  placeholder?: string;
  description?: string;
  default?: string | number | boolean;
  options?: { label: string; value: string }[];
  validation?: { pattern: string; message: string };
}

export interface SetupStep {
  id: string;
  title: string;
  description: string;
  fields: ConfigSchemaField[];
  instruction?: string;
  externalUrl?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  icon: string;
  color: string;
  category: PluginCategory;
  tags: string[];
  capabilities: string[];
  requires: { id: string; label: string }[];
  install: string[];
  configSchema: ConfigSchemaField[];
  setup: SetupStep[];
  installCount: number;
  changelog: { version: string; date: string; notes: string }[];
}

export const pluginRegistry: PluginManifest[] = [
  {
    id: "discord-channel",
    name: "Discord",
    description:
      "Connect your WOPR instance to Discord servers. Supports text channels, threads, DMs, and slash commands.",
    version: "3.2.0",
    author: "WOPR Team",
    icon: "MessageCircle",
    color: "#5865F2",
    category: "channel",
    tags: ["channel", "chat", "community"],
    capabilities: ["channel"],
    requires: [],
    install: [],
    configSchema: [
      {
        key: "botToken",
        label: "Bot Token",
        type: "string",
        required: true,
        secret: true,
        env: "DISCORD_BOT_TOKEN",
        placeholder: "Paste your Discord bot token",
        description: "Found under Bot > Token in the Developer Portal.",
        validation: { pattern: "^[A-Za-z0-9_.-]+$", message: "Invalid token format" },
      },
      {
        key: "guildId",
        label: "Server ID",
        type: "string",
        required: true,
        env: "DISCORD_GUILD_ID",
        placeholder: "e.g. 123456789012345678",
        description: "Right-click server name > Copy Server ID.",
        validation: { pattern: "^\\d{17,20}$", message: "Must be a numeric server ID" },
      },
    ],
    setup: [
      {
        id: "create-bot",
        title: "Create a Discord Bot",
        description: "Create a bot application in the Discord Developer Portal.",
        instruction: "Go to the Discord Developer Portal, create a new application, and navigate to the Bot section.",
        externalUrl: "https://discord.com/developers/applications",
        fields: [],
      },
      {
        id: "configure",
        title: "Enter Bot Credentials",
        description: "Paste your bot token and server ID.",
        fields: [
          {
            key: "botToken",
            label: "Bot Token",
            type: "string",
            required: true,
            secret: true,
            placeholder: "Paste your Discord bot token",
            validation: { pattern: "^[A-Za-z0-9_.-]+$", message: "Invalid token format" },
          },
          {
            key: "guildId",
            label: "Server ID",
            type: "string",
            required: true,
            placeholder: "e.g. 123456789012345678",
            validation: { pattern: "^\\d{17,20}$", message: "Must be a numeric server ID" },
          },
        ],
      },
      {
        id: "done",
        title: "Connection Ready",
        description: "Your Discord bot is configured and ready to connect.",
        fields: [],
      },
    ],
    installCount: 12400,
    changelog: [
      { version: "3.2.0", date: "2026-02-10", notes: "Added thread support and slash commands." },
      { version: "3.1.0", date: "2026-01-15", notes: "DM support and message reactions." },
      { version: "3.0.0", date: "2025-12-01", notes: "Major rewrite with voice channel support." },
    ],
  },
  {
    id: "slack-channel",
    name: "Slack",
    description: "Connect your WOPR instance to Slack workspaces. Supports channels, threads, and app mentions.",
    version: "2.1.0",
    author: "WOPR Team",
    icon: "Hash",
    color: "#4A154B",
    category: "channel",
    tags: ["channel", "chat", "enterprise"],
    capabilities: ["channel"],
    requires: [],
    install: [],
    configSchema: [
      {
        key: "botToken",
        label: "Bot Token",
        type: "string",
        required: true,
        secret: true,
        placeholder: "xoxb-...",
        validation: { pattern: "^xoxb-", message: "Must start with xoxb-" },
      },
      {
        key: "signingSecret",
        label: "Signing Secret",
        type: "string",
        required: true,
        secret: true,
        placeholder: "Paste your signing secret",
      },
    ],
    setup: [
      {
        id: "create-app",
        title: "Create a Slack App",
        description: "Create and install a Slack app in your workspace.",
        instruction: "Go to the Slack API portal and create a new app.",
        externalUrl: "https://api.slack.com/apps",
        fields: [],
      },
      {
        id: "configure",
        title: "Enter Credentials",
        description: "Paste your bot token and signing secret.",
        fields: [
          {
            key: "botToken",
            label: "Bot Token",
            type: "string",
            required: true,
            secret: true,
            placeholder: "xoxb-...",
            validation: { pattern: "^xoxb-", message: "Must start with xoxb-" },
          },
          {
            key: "signingSecret",
            label: "Signing Secret",
            type: "string",
            required: true,
            secret: true,
            placeholder: "Paste your signing secret",
          },
        ],
      },
      {
        id: "done",
        title: "Connection Ready",
        description: "Your Slack workspace is connected.",
        fields: [],
      },
    ],
    installCount: 8200,
    changelog: [
      { version: "2.1.0", date: "2026-02-01", notes: "Thread reply support." },
      { version: "2.0.0", date: "2026-01-01", notes: "App mention and event subscription." },
    ],
  },
  {
    id: "semantic-memory",
    name: "Semantic Memory",
    description:
      "Long-term memory with vector search across conversations. Enables your WOPR to remember context from past interactions.",
    version: "1.4.0",
    author: "WOPR Team",
    icon: "Database",
    color: "#8B5CF6",
    category: "memory",
    tags: ["memory", "vectors", "search"],
    capabilities: ["memory", "embeddings"],
    requires: [],
    install: [],
    configSchema: [
      {
        key: "maxEntries",
        label: "Max Memory Entries",
        type: "number",
        required: false,
        placeholder: "10000",
        default: 10000,
        description: "Maximum number of memory entries to retain.",
      },
      {
        key: "embeddingModel",
        label: "Embedding Model",
        type: "select",
        required: true,
        options: [
          { label: "text-embedding-3-small", value: "text-embedding-3-small" },
          { label: "text-embedding-3-large", value: "text-embedding-3-large" },
        ],
        description: "Model used for generating vector embeddings.",
      },
    ],
    setup: [
      {
        id: "configure",
        title: "Configure Memory",
        description: "Set memory limits and embedding preferences.",
        fields: [
          {
            key: "maxEntries",
            label: "Max Memory Entries",
            type: "number",
            required: false,
            placeholder: "10000",
          },
          {
            key: "embeddingModel",
            label: "Embedding Model",
            type: "select",
            required: true,
            options: [
              { label: "text-embedding-3-small", value: "text-embedding-3-small" },
              { label: "text-embedding-3-large", value: "text-embedding-3-large" },
            ],
          },
        ],
      },
      {
        id: "done",
        title: "Memory Ready",
        description: "Semantic memory is configured and ready.",
        fields: [],
      },
    ],
    installCount: 9800,
    changelog: [
      { version: "1.4.0", date: "2026-02-05", notes: "Improved retrieval accuracy by 40%." },
      { version: "1.3.0", date: "2026-01-10", notes: "Added support for memory namespaces." },
    ],
  },
  {
    id: "elevenlabs-tts",
    name: "ElevenLabs TTS",
    description:
      "High-quality text-to-speech synthesis powered by ElevenLabs. Bring natural voice output to your WOPR.",
    version: "2.0.1",
    author: "WOPR Team",
    icon: "Volume2",
    color: "#000000",
    category: "voice",
    tags: ["voice", "tts", "audio"],
    capabilities: ["voice", "tts"],
    requires: [],
    install: [],
    configSchema: [
      {
        key: "apiKey",
        label: "ElevenLabs API Key",
        type: "string",
        required: true,
        secret: true,
        placeholder: "Paste your ElevenLabs API key",
      },
      {
        key: "voiceId",
        label: "Voice",
        type: "select",
        required: true,
        options: [
          { label: "Rachel (Natural)", value: "rachel" },
          { label: "Adam (Deep)", value: "adam" },
          { label: "Bella (Warm)", value: "bella" },
        ],
        description: "Select a voice for speech synthesis.",
      },
    ],
    setup: [
      {
        id: "api-key",
        title: "Enter API Key",
        description: "Get your API key from ElevenLabs.",
        externalUrl: "https://elevenlabs.io/",
        fields: [
          {
            key: "apiKey",
            label: "ElevenLabs API Key",
            type: "string",
            required: true,
            secret: true,
            placeholder: "Paste your ElevenLabs API key",
          },
        ],
      },
      {
        id: "voice",
        title: "Select Voice",
        description: "Choose a voice for your WOPR.",
        fields: [
          {
            key: "voiceId",
            label: "Voice",
            type: "select",
            required: true,
            options: [
              { label: "Rachel (Natural)", value: "rachel" },
              { label: "Adam (Deep)", value: "adam" },
              { label: "Bella (Warm)", value: "bella" },
            ],
          },
        ],
      },
      {
        id: "done",
        title: "Voice Ready",
        description: "TTS is configured and ready.",
        fields: [],
      },
    ],
    installCount: 5600,
    changelog: [
      { version: "2.0.1", date: "2026-02-08", notes: "Fixed audio buffer handling." },
      { version: "2.0.0", date: "2026-01-20", notes: "Streaming support for real-time TTS." },
    ],
  },
  {
    id: "deepgram-stt",
    name: "Deepgram STT",
    description: "Fast, accurate speech-to-text transcription powered by Deepgram. Add voice input to any channel.",
    version: "1.2.0",
    author: "WOPR Team",
    icon: "Mic",
    color: "#13EF93",
    category: "voice",
    tags: ["voice", "stt", "transcription"],
    capabilities: ["voice", "stt"],
    requires: [],
    install: [],
    configSchema: [
      {
        key: "apiKey",
        label: "Deepgram API Key",
        type: "string",
        required: true,
        secret: true,
        placeholder: "Paste your Deepgram API key",
      },
      {
        key: "language",
        label: "Language",
        type: "select",
        required: true,
        options: [
          { label: "English", value: "en" },
          { label: "Spanish", value: "es" },
          { label: "French", value: "fr" },
          { label: "German", value: "de" },
        ],
        description: "Primary language for transcription.",
      },
    ],
    setup: [
      {
        id: "api-key",
        title: "Enter API Key",
        description: "Get your API key from the Deepgram Console.",
        externalUrl: "https://console.deepgram.com/",
        fields: [
          {
            key: "apiKey",
            label: "Deepgram API Key",
            type: "string",
            required: true,
            secret: true,
            placeholder: "Paste your Deepgram API key",
          },
        ],
      },
      {
        id: "done",
        title: "STT Ready",
        description: "Speech-to-text is configured and ready.",
        fields: [],
      },
    ],
    installCount: 3200,
    changelog: [
      { version: "1.2.0", date: "2026-02-01", notes: "Added multilingual support." },
      { version: "1.1.0", date: "2026-01-05", notes: "Real-time streaming transcription." },
    ],
  },
  {
    id: "webhooks",
    name: "Webhooks",
    description:
      "Send and receive webhooks for external integrations. Connect WOPR to any service with HTTP callbacks.",
    version: "1.1.0",
    author: "WOPR Team",
    icon: "Webhook",
    color: "#F59E0B",
    category: "webhook",
    tags: ["webhook", "integration", "automation"],
    capabilities: ["webhook"],
    requires: [],
    install: [],
    configSchema: [
      {
        key: "secret",
        label: "Webhook Secret",
        type: "string",
        required: false,
        secret: true,
        placeholder: "Optional signing secret",
        description: "Used to verify webhook payloads.",
      },
      {
        key: "retryCount",
        label: "Retry Count",
        type: "number",
        required: false,
        placeholder: "3",
        default: 3,
        description: "Number of retries for failed deliveries.",
      },
    ],
    setup: [
      {
        id: "configure",
        title: "Configure Webhooks",
        description: "Set up webhook endpoints and security.",
        fields: [
          {
            key: "secret",
            label: "Webhook Secret",
            type: "string",
            required: false,
            secret: true,
            placeholder: "Optional signing secret",
          },
        ],
      },
      {
        id: "done",
        title: "Webhooks Ready",
        description: "Webhook endpoints are configured.",
        fields: [],
      },
    ],
    installCount: 7100,
    changelog: [{ version: "1.1.0", date: "2026-01-25", notes: "Added retry queue and dead letter." }],
  },
  {
    id: "github-integration",
    name: "GitHub",
    description:
      "GitHub integration for code review, issue tracking, and PR notifications. Turn WOPR into a dev team assistant.",
    version: "1.3.0",
    author: "WOPR Team",
    icon: "GitBranch",
    color: "#24292E",
    category: "integration",
    tags: ["integration", "github", "development"],
    capabilities: ["integration"],
    requires: [],
    install: [],
    configSchema: [
      {
        key: "token",
        label: "GitHub Personal Access Token",
        type: "string",
        required: true,
        secret: true,
        placeholder: "ghp_...",
        validation: { pattern: "^gh[ps]_", message: "Must start with ghp_ or ghs_" },
      },
      {
        key: "repos",
        label: "Repositories",
        type: "string",
        required: false,
        placeholder: "org/repo1, org/repo2",
        description: "Comma-separated list of repos to monitor.",
      },
    ],
    setup: [
      {
        id: "token",
        title: "Enter GitHub Token",
        description: "Create a fine-grained personal access token.",
        externalUrl: "https://github.com/settings/tokens",
        fields: [
          {
            key: "token",
            label: "GitHub Token",
            type: "string",
            required: true,
            secret: true,
            placeholder: "ghp_...",
            validation: { pattern: "^gh[ps]_", message: "Must start with ghp_ or ghs_" },
          },
        ],
      },
      {
        id: "done",
        title: "GitHub Connected",
        description: "GitHub integration is configured.",
        fields: [],
      },
    ],
    installCount: 4500,
    changelog: [
      { version: "1.3.0", date: "2026-02-03", notes: "PR review comment support." },
      { version: "1.2.0", date: "2026-01-12", notes: "Issue creation from chat." },
    ],
  },
  {
    id: "meeting-transcriber",
    name: "Meeting Transcriber",
    description:
      "Automatic meeting transcription and summarization. Join voice channels and produce meeting notes with action items.",
    version: "1.0.0",
    author: "Community",
    icon: "FileText",
    color: "#6366F1",
    category: "voice",
    tags: ["voice", "transcription", "meetings", "productivity"],
    capabilities: ["stt", "llm"],
    requires: [{ id: "discord-channel", label: "Discord (for voice channels)" }],
    install: ["discord-channel"],
    configSchema: [
      {
        key: "summaryStyle",
        label: "Summary Style",
        type: "select",
        required: true,
        options: [
          { label: "Bullet Points", value: "bullets" },
          { label: "Paragraph", value: "paragraph" },
          { label: "Action Items Only", value: "actions" },
        ],
      },
      {
        key: "autoJoin",
        label: "Auto-join Voice Channels",
        type: "boolean",
        required: false,
        default: false,
        description: "Automatically join when users enter a voice channel.",
      },
    ],
    setup: [
      {
        id: "style",
        title: "Configure Summaries",
        description: "Choose how meeting notes are formatted.",
        fields: [
          {
            key: "summaryStyle",
            label: "Summary Style",
            type: "select",
            required: true,
            options: [
              { label: "Bullet Points", value: "bullets" },
              { label: "Paragraph", value: "paragraph" },
              { label: "Action Items Only", value: "actions" },
            ],
          },
          {
            key: "autoJoin",
            label: "Auto-join Voice Channels",
            type: "boolean",
            required: false,
          },
        ],
      },
      {
        id: "done",
        title: "Transcriber Ready",
        description: "Meeting transcriber is configured.",
        fields: [],
      },
    ],
    installCount: 2100,
    changelog: [{ version: "1.0.0", date: "2026-02-10", notes: "Initial release." }],
  },
  {
    id: "ai-art-bot",
    name: "AI Art Bot",
    description: "Generate images from text prompts directly in chat. Supports multiple styles and aspect ratios.",
    version: "1.1.0",
    author: "Community",
    icon: "Palette",
    color: "#EC4899",
    category: "integration",
    tags: ["image", "art", "creative", "generation"],
    capabilities: ["image-gen"],
    requires: [],
    install: [],
    configSchema: [
      {
        key: "defaultSize",
        label: "Default Image Size",
        type: "select",
        required: true,
        options: [
          { label: "1024x1024", value: "1024x1024" },
          { label: "1024x1792", value: "1024x1792" },
          { label: "1792x1024", value: "1792x1024" },
        ],
      },
      {
        key: "maxPerDay",
        label: "Max Images Per Day",
        type: "number",
        required: false,
        placeholder: "50",
        default: 50,
        description: "Rate limit for image generation per user per day.",
      },
    ],
    setup: [
      {
        id: "configure",
        title: "Configure Image Generation",
        description: "Set defaults for image generation.",
        fields: [
          {
            key: "defaultSize",
            label: "Default Image Size",
            type: "select",
            required: true,
            options: [
              { label: "1024x1024", value: "1024x1024" },
              { label: "1024x1792", value: "1024x1792" },
              { label: "1792x1024", value: "1792x1024" },
            ],
          },
        ],
      },
      {
        id: "done",
        title: "Art Bot Ready",
        description: "AI Art Bot is configured.",
        fields: [],
      },
    ],
    installCount: 3800,
    changelog: [
      { version: "1.1.0", date: "2026-02-07", notes: "Added portrait and landscape sizes." },
      { version: "1.0.0", date: "2026-01-15", notes: "Initial release." },
    ],
  },
  {
    id: "web-ui",
    name: "Web UI",
    description: "Browser-based chat interface for your WOPR. Embeddable widget for websites and standalone chat page.",
    version: "1.0.0",
    author: "WOPR Team",
    icon: "Globe",
    color: "#3B82F6",
    category: "ui",
    tags: ["ui", "web", "chat", "embed"],
    capabilities: ["ui"],
    requires: [],
    install: [],
    configSchema: [
      {
        key: "theme",
        label: "Theme",
        type: "select",
        required: true,
        options: [
          { label: "Light", value: "light" },
          { label: "Dark", value: "dark" },
          { label: "Auto", value: "auto" },
        ],
      },
      {
        key: "welcomeMessage",
        label: "Welcome Message",
        type: "string",
        required: false,
        placeholder: "Hello! How can I help?",
        description: "Shown when a user first opens the chat.",
      },
    ],
    setup: [
      {
        id: "configure",
        title: "Configure Web UI",
        description: "Customize the chat widget appearance.",
        fields: [
          {
            key: "theme",
            label: "Theme",
            type: "select",
            required: true,
            options: [
              { label: "Light", value: "light" },
              { label: "Dark", value: "dark" },
              { label: "Auto", value: "auto" },
            ],
          },
          {
            key: "welcomeMessage",
            label: "Welcome Message",
            type: "string",
            required: false,
            placeholder: "Hello! How can I help?",
          },
        ],
      },
      {
        id: "done",
        title: "Web UI Ready",
        description: "Web chat interface is configured.",
        fields: [],
      },
    ],
    installCount: 6300,
    changelog: [{ version: "1.0.0", date: "2026-01-20", notes: "Initial release with embed support." }],
  },
  {
    id: "content-moderation",
    name: "Content Moderation",
    description:
      "Automatic content moderation for messages. Filters harmful content, spam, and enforces community guidelines.",
    version: "1.5.0",
    author: "WOPR Team",
    icon: "Shield",
    color: "#EF4444",
    category: "moderation",
    tags: ["moderation", "safety", "filtering"],
    capabilities: ["moderation", "llm"],
    requires: [],
    install: [],
    configSchema: [
      {
        key: "sensitivity",
        label: "Sensitivity",
        type: "select",
        required: true,
        options: [
          { label: "Low", value: "low" },
          { label: "Medium", value: "medium" },
          { label: "High", value: "high" },
        ],
        description: "How aggressively to filter content.",
      },
      {
        key: "logActions",
        label: "Log Moderation Actions",
        type: "boolean",
        required: false,
        default: true,
        description: "Keep a log of all moderation actions taken.",
      },
    ],
    setup: [
      {
        id: "configure",
        title: "Configure Moderation",
        description: "Set moderation sensitivity and logging.",
        fields: [
          {
            key: "sensitivity",
            label: "Sensitivity",
            type: "select",
            required: true,
            options: [
              { label: "Low", value: "low" },
              { label: "Medium", value: "medium" },
              { label: "High", value: "high" },
            ],
          },
        ],
      },
      {
        id: "done",
        title: "Moderation Ready",
        description: "Content moderation is configured.",
        fields: [],
      },
    ],
    installCount: 4200,
    changelog: [{ version: "1.5.0", date: "2026-02-06", notes: "Added spam detection and auto-mute." }],
  },
  {
    id: "analytics-dashboard",
    name: "Analytics Dashboard",
    description: "Track usage metrics, conversation analytics, and user engagement across all channels.",
    version: "1.0.0",
    author: "Community",
    icon: "BarChart",
    color: "#10B981",
    category: "analytics",
    tags: ["analytics", "metrics", "reporting"],
    capabilities: ["analytics"],
    requires: [],
    install: [],
    configSchema: [
      {
        key: "retentionDays",
        label: "Data Retention (days)",
        type: "number",
        required: false,
        placeholder: "90",
        default: 90,
        description: "How long to keep analytics data.",
      },
    ],
    setup: [
      {
        id: "configure",
        title: "Configure Analytics",
        description: "Set data retention preferences.",
        fields: [
          {
            key: "retentionDays",
            label: "Data Retention (days)",
            type: "number",
            required: false,
            placeholder: "90",
          },
        ],
      },
      {
        id: "done",
        title: "Analytics Ready",
        description: "Analytics dashboard is configured.",
        fields: [],
      },
    ],
    installCount: 2800,
    changelog: [{ version: "1.0.0", date: "2026-02-01", notes: "Initial release." }],
  },
];
