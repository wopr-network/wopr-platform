CREATE INDEX "fleet_event_history_bot_id_created_at_idx" ON "fleet_event_history" ("bot_id","created_at");
CREATE INDEX "fleet_event_history_tenant_id_created_at_idx" ON "fleet_event_history" ("tenant_id","created_at");
