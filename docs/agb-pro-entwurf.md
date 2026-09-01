# AGB-Entwurf — Roadlight Pro (Bezahl-Abo)

> ⚠️ **ENTWURF — vor dem Live-Gang anwaltlich prüfen lassen.** Dies ist ein
> strukturierter Arbeitsentwurf, **keine Rechtsberatung**. Insbesondere die
> **Widerrufsbelehrung** (§ 7) unterliegt strengen gesetzlichen Formvorgaben und
> muss vor Verwendung geprüft werden. Erst nach der Prüfung als `public/agb.html`
> live schalten (die aktuelle `agb.html` ist die kostenlose Beta-Fassung).

## Offene Entscheidungen (VOR der anwaltlichen Prüfung klären)

1. **Umsatzsteuer.** Im Impressum ist **keine USt-IdNr** angegeben → vermutlich
   **Kleinunternehmer nach § 19 UStG**. Das bestimmt, ob die 9 € brutto=netto sind
   oder ob USt ausgewiesen wird. → Variante A oder B in § 5 wählen. Betrifft auch
   die Stripe-Tax-Konfiguration.
2. **Zielgruppe Verbraucher vs. Unternehmer.** Können auch **Verbraucher** (nicht
   nur Unternehmen) Pro buchen? Wenn ja, greifen Widerrufsrecht (§ 7), Brutto-
   Preisangabe und Verbraucherstreitbeilegung (§ 14). Falls ausschließlich B2B:
   Registrierung müsste die Unternehmereigenschaft abfragen/bestätigen — sonst gilt
   sicherheitshalber das Verbraucherrecht. Dieser Entwurf ist auf den **sicheren
   Fall (Verbraucher möglich)** ausgelegt.
3. **Preis brutto/netto & Währung.** 9 € pro Monat — als Endpreis bestätigen
   (siehe § 5). Jahresabo optional später.

---

## Nutzungsbedingungen für Roadlight (inkl. Pro-Abo)

### 1. Geltungsbereich
Diese Nutzungsbedingungen regeln die Nutzung des Dienstes „Roadlight" (nachfolgend
„Dienst"), erreichbar unter roadlight.pro, betrieben von Ben Kohler, Auf dem Kreuz
32/1, 89073 Ulm (nachfolgend „Betreiber"). Mit der Registrierung eines Workspaces,
dem Abschluss eines kostenpflichtigen Abos oder der sonstigen Nutzung des Dienstes
erkennst du diese Bedingungen an.

### 2. Leistungsbeschreibung
Roadlight ist ein Werkzeug, um öffentliches Produkt-Feedback zu sammeln, darüber
abstimmen zu lassen sowie eine Roadmap und ein Changelog bereitzustellen. Der Dienst
wird in zwei Tarifen angeboten:

- **Free** (kostenlos): ein Board, bis zu zwei Team-Mitglieder, Anzeige eines
  „Powered by Roadlight"-Hinweises auf dem öffentlichen Board.
- **Pro** (kostenpflichtig): unbegrenzte Anzahl an Boards und Team-Mitgliedern,
  Zugriff über API und MCP-Schnittstelle sowie Entfernung des „Powered by
  Roadlight"-Hinweises.

Der konkrete Funktionsumfang ergibt sich aus der jeweils aktuellen Beschreibung auf
roadlight.pro. Der Betreiber darf den Funktionsumfang weiterentwickeln; wesentliche
Einschränkungen bestehender Pro-Funktionen berechtigen zur Kündigung (§ 6).

### 3. Registrierung und Konto
Die Nutzung als Workspace-Inhaber setzt eine Registrierung mit einer gültigen
E-Mail-Adresse voraus. Die Anmeldung erfolgt passwortlos über einen per E-Mail
zugesandten Einmal-Link (Magic Link). Du bist für den Schutz des Zugangs zu deinem
E-Mail-Postfach selbst verantwortlich. Angaben bei der Registrierung müssen
wahrheitsgemäß sein.

### 4. Vertragsschluss über das Pro-Abo
Das Pro-Abo wird über einen kostenpflichtigen Bestellvorgang abgeschlossen. Durch
Auswahl von „Auf Pro upgraden" gelangst du zur gesicherten Bezahlseite unseres
Zahlungsdienstleisters Stripe. Mit Abschluss des dortigen, als zahlungspflichtig
gekennzeichneten Bestellvorgangs kommt ein kostenpflichtiger Vertrag über das
Pro-Abo zwischen dir und dem Betreiber zustande. Du erhältst eine Bestätigung per
E-Mail bzw. über dein Konto.

### 5. Preise und Zahlung
Das Pro-Abo kostet **9 € pro Monat**.

> **Variante A (Kleinunternehmer § 19 UStG):** Der Betreiber ist Kleinunternehmer
> im Sinne des § 19 UStG; es wird **keine Umsatzsteuer ausgewiesen**. Der Preis ist
> ein Endpreis.
>
> **Variante B (umsatzsteuerpflichtig):** Alle Preise verstehen sich inklusive der
> jeweils geltenden gesetzlichen Umsatzsteuer. Die Umsatzsteuer wird auf der
> Rechnung ausgewiesen. Für Kunden in der EU kann sich der auszuweisende Steuersatz
> nach dem Sitz des Kunden richten (Stripe Tax).
>
> → **Eine der beiden Varianten wählen und die andere löschen.**

Die Abrechnung erfolgt im Voraus für den jeweiligen Abrechnungszeitraum (ein Monat)
über den Zahlungsdienstleister **Stripe** (Stripe Payments Europe, Ltd.). Die
Zahlungsabwicklung, Rechnungsstellung und Speicherung der Zahlungsdaten erfolgen
durch Stripe; der Betreiber erhält und speichert **keine vollständigen
Zahlungsdaten** (z. B. Kartennummern). Das Abo **verlängert sich automatisch** um
jeweils einen weiteren Monat, solange es nicht gemäß § 6 gekündigt wird. Die Zahlung
wird zu Beginn jedes Abrechnungszeitraums fällig.

### 6. Laufzeit und Kündigung
Das Pro-Abo läuft zunächst einen Monat und verlängert sich automatisch um jeweils
einen weiteren Monat. Du kannst das Abo **jederzeit zum Ende des laufenden
Abrechnungszeitraums** kündigen — bequem selbst über das Kundenportal („Abo
verwalten" in der Konsole) oder per E-Mail an hallo@roadlight.pro. Mit Wirksamwerden
der Kündigung endet der kostenpflichtige Zugang zum Ende des bereits bezahlten
Zeitraums; der Workspace wird anschließend auf den Free-Tarif zurückgestuft.
**Bereits erstellte Inhalte (Boards, Einträge, Team-Mitglieder) bleiben erhalten**;
Free-Limits gelten dann nur für die Neu-Anlage. Der Betreiber kann den Vertrag mit
angemessener Frist oder aus wichtigem Grund (insbesondere bei Verstoß gegen diese
Bedingungen oder Zahlungsverzug) kündigen. Das Recht zur außerordentlichen Kündigung
bleibt für beide Seiten unberührt.

### 7. Widerrufsrecht für Verbraucher
> ⚠️ **Anwaltlich prüfen.** Der folgende Text orientiert sich am gesetzlichen Muster
> (§§ 355, 356 BGB, Art. 246a EGBGB), muss aber vor Verwendung auf korrekte Form und
> Vollständigkeit geprüft werden.

**Widerrufsbelehrung**

Verbraucher haben das Recht, binnen vierzehn Tagen ohne Angabe von Gründen diesen
Vertrag zu widerrufen. Die Widerrufsfrist beträgt vierzehn Tage ab dem Tag des
Vertragsabschlusses. Um dein Widerrufsrecht auszuüben, musst du uns (Ben Kohler, Auf
dem Kreuz 32/1, 89073 Ulm, E-Mail: hallo@roadlight.pro) mittels einer eindeutigen
Erklärung (z. B. ein mit der Post versandter Brief oder eine E-Mail) über deinen
Entschluss, diesen Vertrag zu widerrufen, informieren. Du kannst dafür das beigefügte
Muster-Widerrufsformular verwenden, das jedoch nicht vorgeschrieben ist. Zur Wahrung
der Widerrufsfrist reicht es aus, dass du die Mitteilung über die Ausübung des
Widerrufsrechts vor Ablauf der Widerrufsfrist absendest.

**Folgen des Widerrufs.** Wenn du diesen Vertrag widerrufst, haben wir dir alle
Zahlungen, die wir von dir erhalten haben, unverzüglich und spätestens binnen
vierzehn Tagen ab dem Tag zurückzuzahlen, an dem die Mitteilung über deinen Widerruf
bei uns eingegangen ist.

**Vorzeitiges Erlöschen bei digitalen Dienstleistungen.** Verlangst du als
Verbraucher, dass die Pro-Leistung bereits während der Widerrufsfrist beginnt,
erlischt dein Widerrufsrecht, wenn wir die Leistung vollständig erbracht haben; bei
einer während der Widerrufsfrist begonnenen, noch nicht vollständig erbrachten
Leistung schuldest du bei Widerruf einen anteiligen Betrag für die bis zum Widerruf
erbrachte Leistung. Wir holen deine ausdrückliche Zustimmung zum sofortigen
Leistungsbeginn und deine Kenntnisnahme vom (teilweisen) Verlust des Widerrufsrechts
im Bestellvorgang ein.

**Muster-Widerrufsformular** (nur ausfüllen und zurücksenden, wenn du den Vertrag
widerrufen möchtest):
An Ben Kohler, Auf dem Kreuz 32/1, 89073 Ulm, hallo@roadlight.pro — Hiermit widerrufe
ich den von mir abgeschlossenen Vertrag über das Roadlight-Pro-Abo. Bestellt am /
Name / Anschrift / Datum / (bei Mitteilung auf Papier: Unterschrift).

### 8. Pflichten der Nutzer
Nutzer verpflichten sich, keine rechtswidrigen, beleidigenden, diskriminierenden oder
gegen Rechte Dritter (insbesondere Urheber-, Marken- oder Persönlichkeitsrechte)
verstoßenden Inhalte einzustellen. Der Dienst darf nicht missbraucht werden,
insbesondere nicht für Spam, automatisierte Massenzugriffe (außerhalb der
bereitgestellten API im vertraglich vorgesehenen Rahmen) oder Versuche, die
Sicherheit oder Verfügbarkeit zu beeinträchtigen.

### 9. Inhalte der Nutzer
Für eingestellte Inhalte (Einträge, Kommentare, Screenshots) bleibt der jeweilige
Nutzer verantwortlich. Workspace-Inhaber sind für die auf ihrem Board
veröffentlichten Inhalte verantwortlich und moderieren diese selbst. Der Betreiber
ist berechtigt, offensichtlich rechtswidrige Inhalte zu entfernen oder Zugänge zu
sperren.

### 10. Verfügbarkeit
Der Betreiber bemüht sich um eine hohe Verfügbarkeit des Dienstes, schuldet jedoch
keine bestimmte Verfügbarkeit oder Reaktionszeit. Wartungsarbeiten, Störungen oder
Weiterentwicklungen können zu vorübergehenden Einschränkungen führen. Bei erheblichen,
vom Betreiber zu vertretenden Ausfällen während eines bezahlten Zeitraums kann eine
angemessene Erstattung oder Gutschrift erfolgen.

### 11. Gewährleistung und Haftung
Der Betreiber haftet unbeschränkt bei Vorsatz und grober Fahrlässigkeit, bei
Verletzung von Leben, Körper oder Gesundheit sowie nach dem Produkthaftungsgesetz.
Bei einfacher Fahrlässigkeit haftet der Betreiber nur bei Verletzung einer
wesentlichen Vertragspflicht (Kardinalpflicht) und begrenzt auf den vertragstypischen,
vorhersehbaren Schaden. Eine weitergehende Haftung ist ausgeschlossen. Die
gesetzlichen Gewährleistungsrechte bleiben unberührt.

### 12. Änderungen der Bedingungen und Preise
Der Betreiber kann diese Bedingungen mit Wirkung für die Zukunft ändern. Über
wesentliche Änderungen — insbesondere Preisänderungen für ein bestehendes Abo —
wird in angemessener Form (z. B. per E-Mail) mit angemessener Frist vor Wirksamwerden
informiert. Widersprichst du einer wesentlichen Änderung nicht innerhalb der
mitgeteilten Frist und nutzt den Dienst weiter, gilt dies als Zustimmung; im Fall
einer Preiserhöhung steht dir ein Sonderkündigungsrecht zum Wirksamwerden der
Änderung zu.

### 13. Datenschutz
Zur Verarbeitung personenbezogener Daten siehe unsere Datenschutzerklärung. Für die
Zahlungsabwicklung ist Stripe eingebunden; Details ergeben sich aus der
Datenschutzerklärung.

### 14. Schlussbestimmungen
Es gilt das Recht der Bundesrepublik Deutschland unter Ausschluss des UN-Kaufrechts;
bei Verbrauchern bleiben zwingende Schutzvorschriften ihres Aufenthaltsstaates
unberührt. Ist der Kunde Unternehmer, juristische Person des öffentlichen Rechts oder
öffentlich-rechtliches Sondervermögen, ist Gerichtsstand Ulm. Die EU-Plattform zur
Online-Streitbeilegung erreichst du unter https://ec.europa.eu/consumers/odr/. Der
Betreiber ist nicht verpflichtet und nicht bereit, an Streitbeilegungsverfahren vor
einer Verbraucherschlichtungsstelle teilzunehmen. Sollte eine Bestimmung unwirksam
sein, bleibt die Wirksamkeit der übrigen Bestimmungen unberührt.

Stand: Entwurf, [Datum vor Live-Gang einsetzen].
