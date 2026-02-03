-- ============================================
-- FamilyManager - Storage Policies
-- ============================================
-- WICHTIG: Die Buckets müssen VOR dieser Migration
-- manuell erstellt werden (über Studio oder API)!
-- ============================================

-- Diese Migration wird einen Fehler werfen, wenn die Buckets nicht existieren.
-- Das ist beabsichtigt - erstelle zuerst die Buckets!

-- ============================================
-- AVATARS BUCKET POLICIES
-- ============================================

-- Jeder kann Avatare sehen (public)
CREATE POLICY "Avatar images are publicly accessible"
ON storage.objects FOR SELECT
USING (bucket_id = 'avatars');

-- User können eigenen Avatar hochladen
-- Struktur: avatars/{user_id}/avatar.jpg
CREATE POLICY "Users can upload own avatar"
ON storage.objects FOR INSERT
WITH CHECK (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
);

-- User können eigenen Avatar aktualisieren
CREATE POLICY "Users can update own avatar"
ON storage.objects FOR UPDATE
USING (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
);

-- User können eigenen Avatar löschen
CREATE POLICY "Users can delete own avatar"
ON storage.objects FOR DELETE
USING (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
);

-- ============================================
-- TASK PHOTOS BUCKET POLICIES
-- ============================================

-- Jeder authentifizierte User kann Task-Fotos sehen
-- (RLS auf tasks Tabelle regelt den eigentlichen Zugriff)
CREATE POLICY "Task photos are publicly accessible"
ON storage.objects FOR SELECT
USING (bucket_id = 'task-photos');

-- Authentifizierte User können Fotos hochladen
-- Struktur: task-photos/{task_id}/{timestamp}.jpg
CREATE POLICY "Authenticated users can upload task photos"
ON storage.objects FOR INSERT
WITH CHECK (
    bucket_id = 'task-photos'
    AND auth.role() = 'authenticated'
);

-- User können eigene Fotos aktualisieren
-- (Für den Fall dass ein Kind das Foto ersetzen muss)
CREATE POLICY "Users can update task photos"
ON storage.objects FOR UPDATE
USING (
    bucket_id = 'task-photos'
    AND auth.role() = 'authenticated'
);

-- Nur Parents sollten Fotos löschen können
-- (Wird über App-Logic geregelt, hier basic Policy)
CREATE POLICY "Authenticated users can delete task photos"
ON storage.objects FOR DELETE
USING (
    bucket_id = 'task-photos'
    AND auth.role() = 'authenticated'
);
