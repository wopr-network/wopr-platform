// src/api/routes/marketplace-registry.ts
// Type definitions for the plugin marketplace manifest format.
// The DB (marketplace_plugins.manifest column) is the single source of truth.
// Use scripts/seed-marketplace-plugins.ts to populate the DB on first run.

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
