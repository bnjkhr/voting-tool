-- ============================================
-- FamilyManager - Supabase Database Schema
-- ============================================
-- Version: 1.0.0 (MVP)
-- Plattformen: iOS, Android, Web
-- ============================================

-- ============================================
-- EXTENSIONS
-- ============================================
-- pgcrypto ist bereits in Supabase installiert (im extensions Schema)

-- ============================================
-- CUSTOM TYPES (ENUMS)
-- ============================================

-- Rollen in einem Haushalt
CREATE TYPE member_role AS ENUM ('parent', 'child');

-- Task-Status
CREATE TYPE task_status AS ENUM (
    'open',
    'in_progress',
    'pending_approval',
    'completed',
    'rejected'
);

-- Task-Schwierigkeit
CREATE TYPE task_difficulty AS ENUM ('easy', 'medium', 'hard');

-- Task-Kategorie
CREATE TYPE task_category AS ENUM (
    'chores',
    'homework',
    'room_cleaning',
    'other'
);

-- Credit-Transaktionstyp
CREATE TYPE transaction_type AS ENUM (
    'task_completed',
    'screentime_redeemed',
    'bonus',
    'penalty',
    'manual_adjustment'
);

-- Einladungsstatus
CREATE TYPE invitation_status AS ENUM ('pending', 'accepted', 'declined', 'expired');

-- ============================================
-- TABLES
-- ============================================

-- --------------------------------------------
-- 1. PROFILES (User-Profile)
-- --------------------------------------------
-- Erweitert auth.users mit App-spezifischen Daten
CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar_url TEXT,
    date_of_birth DATE,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Index für Email-Suche
CREATE INDEX idx_profiles_email ON profiles(email);

-- --------------------------------------------
-- 2. HOUSEHOLDS (Haushalte)
-- --------------------------------------------
CREATE TABLE households (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    avatar_url TEXT,
    created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
    -- Screentime Settings (Credits pro Minute)
    credits_per_minute INT DEFAULT 1 NOT NULL CHECK (credits_per_minute > 0),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- --------------------------------------------
-- 3. HOUSEHOLD_MEMBERS (Mitgliedschaften)
-- --------------------------------------------
-- Verbindet User mit Haushalten, inkl. Rolle
CREATE TABLE household_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    role member_role NOT NULL,
    nickname TEXT, -- Optionaler Spitzname im Haushalt
    joined_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

    -- Ein User kann nur einmal pro Haushalt Mitglied sein
    UNIQUE(household_id, user_id)
);

-- Indexes für häufige Queries
CREATE INDEX idx_household_members_household ON household_members(household_id);
CREATE INDEX idx_household_members_user ON household_members(user_id);

-- --------------------------------------------
-- 4. HOUSEHOLD_INVITATIONS (Einladungen)
-- --------------------------------------------
CREATE TABLE household_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    invited_email TEXT NOT NULL,
    invited_role member_role NOT NULL,
    invited_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    status invitation_status DEFAULT 'pending' NOT NULL,
    token TEXT UNIQUE NOT NULL DEFAULT encode(extensions.gen_random_bytes(32), 'hex'),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days') NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    accepted_at TIMESTAMPTZ
);

-- Index für Token-Lookup
CREATE INDEX idx_invitations_token ON household_invitations(token);
CREATE INDEX idx_invitations_email ON household_invitations(invited_email);

-- --------------------------------------------
-- 5. TASKS (Aufgaben)
-- --------------------------------------------
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    category task_category DEFAULT 'other' NOT NULL,
    difficulty task_difficulty DEFAULT 'medium' NOT NULL,
    credit_value INT NOT NULL CHECK (credit_value >= 0),
    assigned_to UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    status task_status DEFAULT 'open' NOT NULL,
    due_date TIMESTAMPTZ,
    requires_photo BOOLEAN DEFAULT FALSE NOT NULL,
    photo_url TEXT,
    -- Bei Ablehnung: Grund angeben
    rejection_reason TEXT,
    -- Timestamps
    started_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Indexes für häufige Queries
CREATE INDEX idx_tasks_household ON tasks(household_id);
CREATE INDEX idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_due_date ON tasks(due_date);
CREATE INDEX idx_tasks_household_status ON tasks(household_id, status);

-- --------------------------------------------
-- 6. CREDIT_ACCOUNTS (Credit-Konten)
-- --------------------------------------------
-- Ein Account pro Kind pro Haushalt
CREATE TABLE credit_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    balance INT DEFAULT 0 NOT NULL CHECK (balance >= 0),
    total_earned INT DEFAULT 0 NOT NULL CHECK (total_earned >= 0),
    total_spent INT DEFAULT 0 NOT NULL CHECK (total_spent >= 0),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

    -- Ein User hat nur ein Konto pro Haushalt
    UNIQUE(household_id, user_id)
);

-- Indexes
CREATE INDEX idx_credit_accounts_household ON credit_accounts(household_id);
CREATE INDEX idx_credit_accounts_user ON credit_accounts(user_id);

-- --------------------------------------------
-- 7. CREDIT_TRANSACTIONS (Transaktions-Historie)
-- --------------------------------------------
CREATE TABLE credit_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES credit_accounts(id) ON DELETE CASCADE,
    amount INT NOT NULL, -- Positiv = Earned, Negativ = Spent
    transaction_type transaction_type NOT NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    description TEXT NOT NULL,
    created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Index für Account-Historie
CREATE INDEX idx_credit_transactions_account ON credit_transactions(account_id);
CREATE INDEX idx_credit_transactions_created_at ON credit_transactions(created_at DESC);

-- --------------------------------------------
-- 8. SCREENTIME_REDEMPTIONS (Bildschirmzeit-Einlösungen)
-- --------------------------------------------
CREATE TABLE screentime_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES credit_accounts(id) ON DELETE CASCADE,
    credits_spent INT NOT NULL CHECK (credits_spent > 0),
    minutes_earned INT NOT NULL CHECK (minutes_earned > 0),
    redeemed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    -- Tracking ob die Zeit "verbraucht" wurde
    used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days') NOT NULL
);

-- Index
CREATE INDEX idx_screentime_redemptions_account ON screentime_redemptions(account_id);

-- ============================================
-- FUNCTIONS
-- ============================================

-- --------------------------------------------
-- Function: Update updated_at Timestamp
-- --------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- --------------------------------------------
-- Function: Create Profile on User Signup
-- --------------------------------------------
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO profiles (id, email, name)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1))
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- --------------------------------------------
-- Function: Create Credit Account for Child
-- --------------------------------------------
CREATE OR REPLACE FUNCTION create_credit_account_for_child()
RETURNS TRIGGER AS $$
BEGIN
    -- Nur für Kinder ein Credit-Konto erstellen
    IF NEW.role = 'child' THEN
        INSERT INTO credit_accounts (household_id, user_id)
        VALUES (NEW.household_id, NEW.user_id)
        ON CONFLICT (household_id, user_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- --------------------------------------------
-- Function: Update Credits on Task Approval
-- --------------------------------------------
CREATE OR REPLACE FUNCTION update_credits_on_task_approval()
RETURNS TRIGGER AS $$
DECLARE
    v_account_id UUID;
BEGIN
    -- Nur wenn Status von 'pending_approval' zu 'completed' wechselt
    IF NEW.status = 'completed' AND OLD.status = 'pending_approval' THEN
        -- Credit Account finden
        SELECT id INTO v_account_id
        FROM credit_accounts
        WHERE household_id = NEW.household_id
        AND user_id = NEW.assigned_to;

        IF v_account_id IS NOT NULL THEN
            -- Credits gutschreiben
            UPDATE credit_accounts
            SET
                balance = balance + NEW.credit_value,
                total_earned = total_earned + NEW.credit_value,
                updated_at = NOW()
            WHERE id = v_account_id;

            -- Transaction eintragen
            INSERT INTO credit_transactions (
                account_id,
                amount,
                transaction_type,
                task_id,
                description,
                created_by
            ) VALUES (
                v_account_id,
                NEW.credit_value,
                'task_completed',
                NEW.id,
                'Aufgabe erledigt: ' || NEW.title,
                NULL -- System-generiert
            );
        END IF;

        -- Completion Timestamp setzen
        NEW.completed_at = NOW();
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- --------------------------------------------
-- Function: Redeem Credits for Screentime
-- --------------------------------------------
CREATE OR REPLACE FUNCTION redeem_screentime(
    p_account_id UUID,
    p_credits INT
)
RETURNS TABLE (
    success BOOLEAN,
    minutes_earned INT,
    new_balance INT,
    error_message TEXT
) AS $$
DECLARE
    v_current_balance INT;
    v_credits_per_minute INT;
    v_minutes INT;
    v_household_id UUID;
BEGIN
    -- Account und Haushalt laden
    SELECT ca.balance, ca.household_id, h.credits_per_minute
    INTO v_current_balance, v_household_id, v_credits_per_minute
    FROM credit_accounts ca
    JOIN households h ON h.id = ca.household_id
    WHERE ca.id = p_account_id
    FOR UPDATE; -- Lock für Race Conditions

    -- Prüfen ob genug Credits vorhanden
    IF v_current_balance < p_credits THEN
        RETURN QUERY SELECT FALSE, 0, v_current_balance, 'Nicht genug Credits'::TEXT;
        RETURN;
    END IF;

    -- Minuten berechnen
    v_minutes := p_credits / v_credits_per_minute;

    IF v_minutes < 1 THEN
        RETURN QUERY SELECT FALSE, 0, v_current_balance, 'Mindestens genug Credits für 1 Minute benötigt'::TEXT;
        RETURN;
    END IF;

    -- Credits abziehen
    UPDATE credit_accounts
    SET
        balance = balance - p_credits,
        total_spent = total_spent + p_credits,
        updated_at = NOW()
    WHERE id = p_account_id;

    -- Transaction eintragen
    INSERT INTO credit_transactions (
        account_id,
        amount,
        transaction_type,
        description
    ) VALUES (
        p_account_id,
        -p_credits,
        'screentime_redeemed',
        v_minutes || ' Minuten Bildschirmzeit eingelöst'
    );

    -- Redemption eintragen
    INSERT INTO screentime_redemptions (
        account_id,
        credits_spent,
        minutes_earned
    ) VALUES (
        p_account_id,
        p_credits,
        v_minutes
    );

    RETURN QUERY SELECT TRUE, v_minutes, v_current_balance - p_credits, NULL::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- --------------------------------------------
-- Function: Check Household Membership
-- --------------------------------------------
CREATE OR REPLACE FUNCTION is_household_member(p_household_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM household_members
        WHERE household_id = p_household_id
        AND user_id = p_user_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- --------------------------------------------
-- Function: Check if User is Parent in Household
-- --------------------------------------------
CREATE OR REPLACE FUNCTION is_household_parent(p_household_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM household_members
        WHERE household_id = p_household_id
        AND user_id = p_user_id
        AND role = 'parent'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- --------------------------------------------
-- Function: Get User's Households
-- --------------------------------------------
CREATE OR REPLACE FUNCTION get_user_households(p_user_id UUID)
RETURNS SETOF UUID AS $$
BEGIN
    RETURN QUERY
    SELECT household_id FROM household_members WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- TRIGGERS
-- ============================================

-- Auto-Update updated_at
CREATE TRIGGER update_profiles_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_households_updated_at
    BEFORE UPDATE ON households
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_credit_accounts_updated_at
    BEFORE UPDATE ON credit_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Create Profile on Signup
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Create Credit Account for Children
CREATE TRIGGER on_household_member_created
    AFTER INSERT ON household_members
    FOR EACH ROW EXECUTE FUNCTION create_credit_account_for_child();

-- Update Credits on Task Approval
CREATE TRIGGER on_task_status_change
    BEFORE UPDATE OF status ON tasks
    FOR EACH ROW EXECUTE FUNCTION update_credits_on_task_approval();

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE households ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE screentime_redemptions ENABLE ROW LEVEL SECURITY;

-- --------------------------------------------
-- PROFILES Policies
-- --------------------------------------------
-- Jeder kann sein eigenes Profil sehen
CREATE POLICY "Users can view own profile"
    ON profiles FOR SELECT
    USING (auth.uid() = id);

-- User können Profile von Haushaltsmitgliedern sehen
CREATE POLICY "Users can view household members profiles"
    ON profiles FOR SELECT
    USING (
        id IN (
            SELECT hm2.user_id FROM household_members hm1
            JOIN household_members hm2 ON hm1.household_id = hm2.household_id
            WHERE hm1.user_id = auth.uid()
        )
    );

-- Jeder kann sein eigenes Profil bearbeiten
CREATE POLICY "Users can update own profile"
    ON profiles FOR UPDATE
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- --------------------------------------------
-- HOUSEHOLDS Policies
-- --------------------------------------------
-- Mitglieder können ihren Haushalt sehen
CREATE POLICY "Members can view their households"
    ON households FOR SELECT
    USING (is_household_member(id, auth.uid()));

-- Jeder eingeloggte User kann einen Haushalt erstellen
CREATE POLICY "Authenticated users can create households"
    ON households FOR INSERT
    WITH CHECK (auth.uid() = created_by);

-- Nur Parents können den Haushalt bearbeiten
CREATE POLICY "Parents can update household"
    ON households FOR UPDATE
    USING (is_household_parent(id, auth.uid()))
    WITH CHECK (is_household_parent(id, auth.uid()));

-- Nur der Ersteller kann den Haushalt löschen
CREATE POLICY "Creator can delete household"
    ON households FOR DELETE
    USING (created_by = auth.uid());

-- --------------------------------------------
-- HOUSEHOLD_MEMBERS Policies
-- --------------------------------------------
-- Mitglieder können alle Mitglieder ihres Haushalts sehen
CREATE POLICY "Members can view household members"
    ON household_members FOR SELECT
    USING (is_household_member(household_id, auth.uid()));

-- Household-Ersteller kann sich selbst als erstes Mitglied (Parent) hinzufügen
CREATE POLICY "Creator can add themselves as first member"
    ON household_members FOR INSERT
    WITH CHECK (
        user_id = auth.uid()
        AND role = 'parent'
        AND EXISTS (
            SELECT 1 FROM households
            WHERE id = household_id
            AND created_by = auth.uid()
        )
    );

-- Parents können weitere Mitglieder hinzufügen
CREATE POLICY "Parents can add members"
    ON household_members FOR INSERT
    WITH CHECK (is_household_parent(household_id, auth.uid()));

-- Parents können Mitglieder entfernen (außer sich selbst als letzten Parent)
CREATE POLICY "Parents can remove members"
    ON household_members FOR DELETE
    USING (is_household_parent(household_id, auth.uid()));

-- User können sich selbst aus einem Haushalt entfernen
CREATE POLICY "Users can leave household"
    ON household_members FOR DELETE
    USING (user_id = auth.uid());

-- --------------------------------------------
-- HOUSEHOLD_INVITATIONS Policies
-- --------------------------------------------
-- Parents können Einladungen ihres Haushalts sehen
CREATE POLICY "Parents can view invitations"
    ON household_invitations FOR SELECT
    USING (is_household_parent(household_id, auth.uid()));

-- Eingeladene können ihre Einladung per Token sehen
CREATE POLICY "Invited users can view their invitation"
    ON household_invitations FOR SELECT
    USING (invited_email = (SELECT email FROM profiles WHERE id = auth.uid()));

-- Parents können Einladungen erstellen
CREATE POLICY "Parents can create invitations"
    ON household_invitations FOR INSERT
    WITH CHECK (is_household_parent(household_id, auth.uid()));

-- Parents können Einladungen löschen/zurückziehen
CREATE POLICY "Parents can delete invitations"
    ON household_invitations FOR DELETE
    USING (is_household_parent(household_id, auth.uid()));

-- Eingeladene können den Status ihrer Einladung aktualisieren
CREATE POLICY "Invited users can update invitation status"
    ON household_invitations FOR UPDATE
    USING (invited_email = (SELECT email FROM profiles WHERE id = auth.uid()))
    WITH CHECK (invited_email = (SELECT email FROM profiles WHERE id = auth.uid()));

-- --------------------------------------------
-- TASKS Policies
-- --------------------------------------------
-- Haushaltsmitglieder können Tasks ihres Haushalts sehen
CREATE POLICY "Members can view household tasks"
    ON tasks FOR SELECT
    USING (is_household_member(household_id, auth.uid()));

-- Parents können Tasks erstellen
CREATE POLICY "Parents can create tasks"
    ON tasks FOR INSERT
    WITH CHECK (
        is_household_parent(household_id, auth.uid())
        AND created_by = auth.uid()
    );

-- Parents können alle Tasks ihres Haushalts bearbeiten
CREATE POLICY "Parents can update any task"
    ON tasks FOR UPDATE
    USING (is_household_parent(household_id, auth.uid()));

-- Kinder können ihre eigenen zugewiesenen Tasks bearbeiten (Status ändern)
-- Hinweis: Die Status-Einschränkung wird über App-Logic geregelt,
-- da WITH CHECK keinen Zugriff auf NEW hat
CREATE POLICY "Children can update assigned tasks"
    ON tasks FOR UPDATE
    USING (
        assigned_to = auth.uid()
        AND is_household_member(household_id, auth.uid())
    )
    WITH CHECK (
        assigned_to = auth.uid()
    );

-- Parents können Tasks löschen
CREATE POLICY "Parents can delete tasks"
    ON tasks FOR DELETE
    USING (is_household_parent(household_id, auth.uid()));

-- --------------------------------------------
-- CREDIT_ACCOUNTS Policies
-- --------------------------------------------
-- Haushaltsmitglieder können Credit-Accounts ihres Haushalts sehen
CREATE POLICY "Members can view household credit accounts"
    ON credit_accounts FOR SELECT
    USING (is_household_member(household_id, auth.uid()));

-- Accounts werden automatisch per Trigger erstellt, kein manuelles Insert nötig
-- Parents können Accounts manuell anpassen (Bonus/Penalty)
CREATE POLICY "Parents can update credit accounts"
    ON credit_accounts FOR UPDATE
    USING (is_household_parent(household_id, auth.uid()));

-- --------------------------------------------
-- CREDIT_TRANSACTIONS Policies
-- --------------------------------------------
-- User können ihre eigenen Transaktionen sehen
CREATE POLICY "Users can view own transactions"
    ON credit_transactions FOR SELECT
    USING (
        account_id IN (
            SELECT id FROM credit_accounts WHERE user_id = auth.uid()
        )
    );

-- Parents können alle Transaktionen ihres Haushalts sehen
CREATE POLICY "Parents can view household transactions"
    ON credit_transactions FOR SELECT
    USING (
        account_id IN (
            SELECT ca.id FROM credit_accounts ca
            JOIN household_members hm ON hm.household_id = ca.household_id
            WHERE hm.user_id = auth.uid() AND hm.role = 'parent'
        )
    );

-- Transaktionen werden nur per Function/Trigger erstellt
CREATE POLICY "System can insert transactions"
    ON credit_transactions FOR INSERT
    WITH CHECK (
        -- Parents können manuelle Anpassungen machen
        (
            created_by = auth.uid()
            AND transaction_type IN ('bonus', 'penalty', 'manual_adjustment')
            AND account_id IN (
                SELECT ca.id FROM credit_accounts ca
                WHERE is_household_parent(ca.household_id, auth.uid())
            )
        )
    );

-- --------------------------------------------
-- SCREENTIME_REDEMPTIONS Policies
-- --------------------------------------------
-- User können ihre eigenen Redemptions sehen
CREATE POLICY "Users can view own redemptions"
    ON screentime_redemptions FOR SELECT
    USING (
        account_id IN (
            SELECT id FROM credit_accounts WHERE user_id = auth.uid()
        )
    );

-- Parents können alle Redemptions ihres Haushalts sehen
CREATE POLICY "Parents can view household redemptions"
    ON screentime_redemptions FOR SELECT
    USING (
        account_id IN (
            SELECT ca.id FROM credit_accounts ca
            WHERE is_household_parent(ca.household_id, auth.uid())
        )
    );

-- ============================================
-- STORAGE BUCKETS
-- ============================================
-- Diese müssen über die Supabase UI oder API erstellt werden:
--
-- 1. Bucket: "avatars" (für Profil- und Haushalt-Avatare)
--    - Public: true
--    - Allowed MIME types: image/jpeg, image/png, image/webp
--    - Max file size: 2MB
--
-- 2. Bucket: "task-photos" (für Task-Beweisfotos)
--    - Public: true (oder signed URLs verwenden)
--    - Allowed MIME types: image/jpeg, image/png
--    - Max file size: 5MB

-- ============================================
-- SEED DATA (Optional für Development)
-- ============================================
-- Uncomment für Test-Daten

/*
-- Test Household
INSERT INTO households (id, name, created_by, credits_per_minute)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Familie Müller',
    (SELECT id FROM auth.users LIMIT 1),
    1
);
*/

-- ============================================
-- USEFUL QUERIES (für Debugging)
-- ============================================

-- Alle Tasks eines Haushalts mit Benutzerinfos
/*
SELECT
    t.*,
    p_assigned.name as assigned_to_name,
    p_created.name as created_by_name
FROM tasks t
JOIN profiles p_assigned ON p_assigned.id = t.assigned_to
JOIN profiles p_created ON p_created.id = t.created_by
WHERE t.household_id = 'YOUR_HOUSEHOLD_ID';
*/

-- Credit-Leaderboard eines Haushalts
/*
SELECT
    p.name,
    ca.balance,
    ca.total_earned,
    ca.total_spent
FROM credit_accounts ca
JOIN profiles p ON p.id = ca.user_id
WHERE ca.household_id = 'YOUR_HOUSEHOLD_ID'
ORDER BY ca.total_earned DESC;
*/

-- ============================================
-- END OF SCHEMA
-- ============================================
