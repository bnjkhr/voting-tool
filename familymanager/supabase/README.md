# FamilyManager - Supabase Setup

## Lokale Entwicklung

### Voraussetzungen
- Docker Desktop (muss laufen)
- Supabase CLI (`brew install supabase/tap/supabase`)

### Starten

```bash
# Supabase lokal starten (Docker muss laufen)
supabase start

# Zeigt URLs und Keys
supabase status
```

Nach dem Start läuft:
- **API:** http://127.0.0.1:54321
- **Studio:** http://127.0.0.1:54323 (Web-UI für DB)
- **Inbucket:** http://127.0.0.1:54324 (Fake-Email-Server für Auth)

### Stoppen

```bash
supabase stop
```

---

## Migrationen

### Neue Migration erstellen

```bash
supabase migration new migration_name
```

### Migrationen anwenden (lokal)

```bash
supabase db reset  # Löscht alles und wendet alle Migrationen neu an
```

### Migrationen auf Production anwenden

```bash
supabase db push
```

---

## Storage Buckets

Die Storage-Buckets müssen manuell erstellt werden (entweder über Studio oder API):

### 1. Avatars Bucket
- **Name:** `avatars`
- **Public:** Yes
- **MIME Types:** image/jpeg, image/png, image/webp
- **Max Size:** 2MB

### 2. Task Photos Bucket
- **Name:** `task-photos`
- **Public:** Yes
- **MIME Types:** image/jpeg, image/png
- **Max Size:** 5MB

### Storage Policies (SQL)

Nach dem Erstellen der Buckets, diese Policies im SQL Editor ausführen:

```sql
-- Avatars: Jeder kann lesen, nur eigene hochladen
CREATE POLICY "Avatar images are publicly accessible"
ON storage.objects FOR SELECT
USING (bucket_id = 'avatars');

CREATE POLICY "Users can upload own avatar"
ON storage.objects FOR INSERT
WITH CHECK (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can update own avatar"
ON storage.objects FOR UPDATE
USING (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Task Photos: Haushaltsmitglieder können lesen/schreiben
CREATE POLICY "Task photos are publicly accessible"
ON storage.objects FOR SELECT
USING (bucket_id = 'task-photos');

CREATE POLICY "Household members can upload task photos"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'task-photos' AND auth.role() = 'authenticated');
```

---

## Type Generation (für Flutter)

```bash
# Generiert Dart-Types aus dem Schema
supabase gen types dart --local > lib/data/models/database.types.dart
```

---

## Production Deployment

### 1. Supabase Projekt erstellen
1. Gehe zu https://supabase.com
2. Erstelle neues Projekt
3. Kopiere URL und Anon Key

### 2. Projekt verknüpfen

```bash
supabase link --project-ref YOUR_PROJECT_REF
```

### 3. Migrationen deployen

```bash
supabase db push
```

### 4. Storage Buckets erstellen
- Im Supabase Dashboard unter Storage

---

## Nützliche Befehle

```bash
# Status prüfen
supabase status

# Logs anzeigen
supabase logs

# SQL ausführen
supabase db execute -f path/to/file.sql

# Datenbank zurücksetzen
supabase db reset

# Remote DB Schema ziehen
supabase db pull
```

---

## Troubleshooting

### "Docker not running"
- Docker Desktop starten

### "Port already in use"
```bash
supabase stop
docker ps  # Prüfen ob noch Container laufen
docker stop $(docker ps -q)  # Alle Container stoppen
```

### Migration fehlgeschlagen
```bash
supabase db reset  # Alles zurücksetzen
# Fehler in der Migration beheben
supabase db reset  # Erneut versuchen
```
