# App Feature Voting Tool

Ein modernes, minimalistisches Online-Voting-Tool für App-Feature-Vorschläge.

## Features

- ✨ **App-Auswahl**: Wähle aus verschiedenen Apps aus
- 💡 **Vorschläge einreichen**: Reiche neue Feature-Ideen ein
- 🗳️ **Voting**: Vote für bestehende Vorschläge (max. 1 Vote pro Vorschlag)
- 🎨 **Flat Design**: Modernes, minimalistisches Interface
- 📱 **Responsive**: Funktioniert auf Desktop und Mobile
- 🔐 **Keine Anmeldung**: Funktioniert ohne Account-Zwang

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JavaScript
- **Backend**: Express.js (Serverless Functions)
- **Database**: Firebase Firestore
- **Deployment**: Vercel

## Setup

### 1. Firebase einrichten

1. Erstelle ein neues Firebase-Projekt
2. Aktiviere Firestore Database
3. Erstelle einen Service Account Key
4. Lade die Service Account JSON herunter

### 2. Environment Variables

Kopiere `.env.example` zu `.env` und fülle die Werte aus:

```bash
cp .env.example .env
```

### 3. Dependencies installieren

```bash
npm install
```

### 4. Standard-Apps erstellen (optional)

```bash
npm run init-firebase
```

Das Skript kann jederzeit erneut ausgefuehrt werden und legt fehlende Standard-Apps (z.B. `GymBo` und `FamilyManager`) an, ohne bestehende Apps zu duplizieren.

### 5. Lokal testen

```bash
npm run dev
```

### 6. Vercel Deployment

1. Installiere Vercel CLI: `npm i -g vercel`
2. Login: `vercel login`
3. Deploy: `vercel --prod`
4. Setze Environment Variables in Vercel Dashboard

## Isolierter Test-Tenant auf geteilter Datenbank

Wenn nur eine Firestore-Datenbank vorhanden ist, kann ein sicher isolierter Test-Tenant
für Staging-/Preview-Deployments genutzt werden. Die bestehenden Live-Daten im
`legacy`-Tenant bleiben dabei unberührt.

Wichtige Regeln:

- Test-Tenant-Slugs muessen mit `test-` oder `staging-` beginnen.
- Der bestehende Live-Betrieb bleibt unter dem `legacy`-Tenant.
- Vor echten Schreibvorgängen zuerst immer einen Dry-Run ausführen.

Beispiele:

```bash
npm run test-tenant:create:dry-run -- --tenant-slug staging-saas-smoke
npm run test-tenant:create -- --tenant-slug staging-saas-smoke
```

Das Skript legt einen isolierten Tenant, ein Test-Board, einen Counter, eine geplante
Release und zwei Beispiel-Einträge an.

Aufräumen:

```bash
npm run test-tenant:delete -- --tenant-slug staging-saas-smoke --confirm-delete --dry-run
npm run test-tenant:delete -- --tenant-slug staging-saas-smoke --confirm-delete
```

Bestehende Daten für Mandantenfähigkeit vorbereiten:

```bash
npm run bootstrap-tenancy:dry-run
```

## SaaS-Tenant provisionieren

Neue SaaS-Tenants werden additiv neben `legacy` angelegt. Der erste Schritt legt
einen Tenant, ein erstes Board und den Ticket-Counter an.

Dry-Run:

```bash
npm run tenant:create:dry-run -- --tenant-name "Acme GmbH" --app-name "Feedback Board" --ticket-prefix AC
```

Echter Schreibvorgang:

```bash
npm run tenant:create -- --tenant-name "Acme GmbH" --app-name "Feedback Board" --ticket-prefix AC
```

Optional kann der Tenant-Slug explizit gesetzt werden:

```bash
npm run tenant:create -- --tenant-slug acme --tenant-name "Acme GmbH"
```

`legacy` ist gesperrt und kann nicht über das SaaS-Provisioning erstellt werden.

## Firestore Datenbank Schema

### Collections

```
apps/
  - id (auto)
  - name: string
  - description: string

suggestions/
  - id (auto)
  - appId: string
  - title: string
  - description: string
  - votes: number
  - createdAt: timestamp

votes/
  - id (auto)
  - suggestionId: string
  - userFingerprint: string (IP + User-Agent hash)
  - timestamp: timestamp
```

## API Endpoints

Bestehende Public- und Admin-Pfade bleiben Legacy-kompatibel und liefern nur Daten
aus dem `legacy`-Tenant.

- `GET /api/apps` - Alle Apps abrufen
- `GET /api/apps/:appId/suggestions` - Vorschläge für eine App
- `POST /api/apps/:appId/suggestions` - Neuen Vorschlag erstellen
- `POST /api/suggestions/:suggestionId/vote` - Für Vorschlag voten
- `GET /api/suggestions/:suggestionId/voted` - Prüfen ob User bereits gevotet hat

Additive SaaS-Public-Pfade für aktive Tenants:

- `GET /api/tenants/:tenantSlug` - Tenant per Slug abrufen
- `GET /api/tenants/:tenantSlug/apps` - Apps eines Tenants abrufen
- `GET /api/tenants/:tenantSlug/apps/:appSlug` - App eines Tenants per Slug abrufen
- `GET /api/tenants/:tenantSlug/apps/:appSlug/suggestions` - Freigegebene Einträge einer App abrufen
- `POST /api/tenants/:tenantSlug/apps/:appSlug/suggestions` - Neuen Eintrag für eine Tenant-App erstellen
- `GET /api/tenants/:tenantSlug/apps/:appSlug/releases` - Releases einer App abrufen
- `GET /api/tenants/:tenantSlug/suggestions/:suggestionId/comments` - Öffentliche Kommentare eines Tenant-Eintrags abrufen
- `POST /api/tenants/:tenantSlug/suggestions/:suggestionId/comments` - Kommentar für einen Tenant-Eintrag einreichen
- `POST /api/tenants/:tenantSlug/suggestions/:suggestionId/vote` - Für Tenant-Eintrag voten
- `DELETE /api/tenants/:tenantSlug/suggestions/:suggestionId/vote` - Vote für Tenant-Eintrag entfernen
- `GET /api/tenants/:tenantSlug/suggestions/:suggestionId/voted` - Prüfen ob User für Tenant-Eintrag gevotet hat

Additive SaaS-Admin-Pfade:

- `POST /api/admin/tenants` - Neuen Tenant mit erstem Board provisionieren
- `GET /api/admin/tenants/:tenantSlug/apps` - Tenant-Apps abrufen
- `GET /api/admin/tenants/:tenantSlug/stats` - Tenant-Statistiken abrufen
- `GET /api/admin/tenants/:tenantSlug/suggestions` - Tenant-Einträge administrativ abrufen

## License

MIT# Vercel Deployment Trigger
