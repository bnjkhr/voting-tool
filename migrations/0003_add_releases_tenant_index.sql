-- Performance: releases.listByTenant filtert auf tenant_id und sortiert nach
-- created_at desc. Bisher gab es nur (app_id, status) — die tenant-gescopte
-- Konsolen-Abfrage lief also als Seq-Scan (cubic-Finding zu PR C5). Ergänzt den
-- passenden Composite-Index, analog zu apps_tenant_idx / suggestions_tenant_idx.

create index if not exists releases_tenant_created_idx
  on releases (tenant_id, created_at desc);
