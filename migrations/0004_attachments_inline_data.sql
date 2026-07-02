-- Screenshots (PR D): Bytes werden direkt in Postgres gehalten statt in einem
-- externen Blob-Store. Die attachments-Tabelle bekommt eine data-Spalte (bytea)
-- und storage_key wird optional (wird erst bei einer späteren R2-Migration
-- gefüllt). Ausgeliefert werden die Bilder über einen Proxy-Endpoint, der die
-- Bytes streamt — der Client-Contract (screenshots[] = img-src-URLs) bleibt.

alter table attachments alter column storage_key drop not null;
alter table attachments add column if not exists data bytea;

-- Genau eine Quelle je Zeile: entweder inline-data (Postgres) ODER storage_key
-- (externer Store). Verhindert leere Attachments.
alter table attachments
  add constraint attachments_data_or_key
  check (data is not null or storage_key is not null);
