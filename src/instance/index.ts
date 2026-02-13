/**
 * Instance management — Docker lifecycle, storage, and templates.
 *
 * This module will host extracted platform code from core (WOP-297):
 * - instance-manager: Docker instance lifecycle
 * - instance-storage: per-instance WOPR_HOME
 * - docker-client: Docker API wrapper
 * - template-engine: instance templates
 *
 * For now, fleet/ contains the working Docker integration from prior PRs.
 * This directory is the target for the core extraction migration.
 */
